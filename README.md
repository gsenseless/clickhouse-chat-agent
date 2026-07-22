# ClickHouse chat agent for Polymarket — charts, not walls of text

A [Trigger.dev chat agent](https://trigger.dev/docs/ai-chat/overview) that answers Polymarket questions by writing and running SQL against [ClickHouse Cloud](https://clickhouse.com/cloud), then returning **interactive charts, tables, and stat cards** instead of long text dumps.

The agent decides when visualization beats prose by calling `renderVisualization` with a [json-render](https://json-render.dev) spec. The Next.js UI renders that spec live with [shadcn/ui](https://ui.shadcn.com) and [shadcn charts](https://ui.shadcn.com/charts) (Recharts).

## How it works

The agent in `src/trigger/clickhouse-agent.ts` is a single `chat.agent()` task. Trigger.dev handles sessions, turn orchestration, streaming, and resumability.

Its system prompt is a versioned [AI Prompt](https://trigger.dev/docs/ai/prompts) (`prompts.define()` + `chat.prompt.set()`), so you can tune guidance/model settings in the Trigger.dev dashboard without redeploying.

It exposes four tools:

- `describeTable`: Returns column names/types for allowed tables (`polymarket.markets`, `polymarket.trades`) using bound `Identifier` params (no SQL interpolation).
- `runQuery`: Executes read-only SQL only (`SELECT`/`WITH`/`DESCRIBE`/`EXPLAIN`/`EXISTS`), enforces allowed-table scope, sets `readonly=2`, caps results at 1,000 rows, and applies a 30s timeout.
- `filterColumnsForVisualization`: Drops irrelevant columns (never rows) before rendering, based on prompt relevance plus optional column metadata.
- `renderVisualization`: Accepts a json-render spec and validates it against the shared catalog. If invalid, errors are returned so the model can correct and retry.

Important contract for `renderVisualization`:

- Pass `spec` as a structured object payload: `{ root, elements }`.
- Do not pass a JSON string (`JSON.stringify(...)` is rejected).

The shared catalog in `src/lib/catalog.ts` defines the model-allowed components (`Card`, `Grid`, `Table`, `Badge`, plus custom `BarChart`, `LineChart`, `AreaChart`, `PieChart`, `Stat`, and `PointMap`).

The frontend (`src/app`, `src/components`) uses [`useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) with [`useTriggerChatTransport`](https://trigger.dev/docs/ai-chat/frontend). The browser streams directly from Trigger.dev durable chat sessions (no custom API route required).

## Setup

1. Create a project in the [Trigger.dev dashboard](https://cloud.trigger.dev) and copy:
   - project ref
   - dev secret key

2. Configure local environment:

   ```sh
   cp .env.example .env
   # paste TRIGGER_PROJECT_REF and TRIGGER_SECRET_KEY into .env
   ```

3. In Trigger.dev dashboard environment variables (Dev, and Prod if deploying), set:

   - `CLICKHOUSE_URL`: ClickHouse HTTPS URL with credentials, for example:
     `https://default:YOUR_PASSWORD@YOUR_SERVICE.clickhouse.cloud:8443`
   - `NIM_API_KEY`: NVIDIA NIM API key
   - `NIM_MODEL` (optional): defaults to `nvidia/nemotron-3-super-120b-a12b`

4. Install and run in two terminals:

   ```sh
   pnpm install
   pnpm dev:trigger
   pnpm dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## Try asking

- "Show me the top 5 largest trades over $10k on sports markets."
- "Show me how the probability of Trump winning evolved over time."
- "Show the top markets by April trade volume as a bar chart."
- "Compare daily trade counts vs daily USD volume in April 2026."

## Data scope notes

- Only `polymarket.markets` and `polymarket.trades` are queryable.
- `polymarket.trades` currently covers April 2026 only.
- If you ask for out-of-scope periods/fields, the agent should say so explicitly.

## Deploy

Deploy the agent task:

```sh
pnpm deploy:trigger
```

For production, set dashboard env vars (`CLICKHOUSE_URL`, `NIM_API_KEY`, optional `NIM_MODEL`) and deploy the Next.js app with `TRIGGER_SECRET_KEY`.

If using self-hosted Trigger.dev (not `cloud.trigger.dev`), also set:

- server-side: `TRIGGER_API_URL`
- browser-side: `NEXT_PUBLIC_TRIGGER_API_URL`
