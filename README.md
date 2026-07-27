# ClickHouse chat agent for Polymarket — charts, not walls of text

A [Trigger.dev chat agent](https://trigger.dev/docs/ai-chat/overview) that answers Polymarket questions by writing and running SQL against [ClickHouse Cloud](https://clickhouse.com/cloud), then returning **interactive charts, tables, and stat cards** instead of long text dumps.


## How it works

The agent in `src/trigger/clickhouse-agent.ts` is a single `chat.agent()` task. Trigger.dev handles sessions, turn orchestration, streaming, and resumability.

```mermaid
flowchart LR
   prompt["User prompt"] -->|Ask a question| ui["UI app"]
   ui -->|Stream prompt| agent["Trigger.dev agent"]
   agent -->|Conversation and tool context| llm["LLM provider<br/>NVIDIA NIM"]
   llm -.->|Model output and tool calls| agent
   agent -->|Validated read-only SQL| clickhouse[("ClickHouse")]
   clickhouse -.->|Query rows| agent
   agent -.->|Stream text or visualization spec| ui
   ui -.->|Render answer| prompt
```


It exposes four tools:

- `describeTable`: Returns column names/types for allowed tables (`polymarket.markets`, `polymarket.trades`).
- `runQuery`: Executes read-only SQL.
- `filterColumnsForVisualization`: Drops irrelevant columns (never rows) before rendering, based on prompt relevance plus optional column metadata.
- `renderVisualization`: Accepts a json-render spec and validates it against the shared catalog. If invalid, errors are returned so the model can correct and retry.

## Notes

- Domain-specific data context is provided to the agent in [src/lib/polymarket-context.ts](src/lib/polymarket-context.ts).
- ClickHouse is indexed with tokenizer-based text index:

```sql
ALTER TABLE polymarket.markets
   ADD INDEX idx_question_text lower(question) TYPE text(tokenizer = splitByNonAlpha);
```

- The agent works with two tables only (`polymarket.markets`, `polymarket.trades`), and `polymarket.trades` is approximately ~150M rows.
- The system prompt explains how to query ClickHouse in an index-aware way (token search + `lower(...)` on indexed text columns).



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

4. Prepare ClickHouse schema/data. Run against your ClickHouse instance:
   - `scripts/clickhouse/01_setup_database.sql`
   - `scripts/clickhouse/02_setup_markets.sql`
   - `scripts/clickhouse/03_setup_trades.sql`
   - `scripts/clickhouse/04_setup_indexes.sql`

Model note: It works with weak model. Expect better results with more advanced models.

5. Install and run in two terminals:

   ```sh
   pnpm install
   pnpm dev:trigger
   # pnpm deploy:trigger  ### to deploy on trigger.dev
   pnpm dev
   ```

6. Open [http://localhost:3000](http://localhost:3000).

## Try asking

- "Show me the top 5 largest trades over $10k on sports markets."
- "Show me how the probability of Trump winning evolved over time."
- "Show the top markets by April trade volume as a bar chart."
- "Compare daily trade counts vs daily USD volume in April 2026."

## Data scope notes

- Only `polymarket.markets` and `polymarket.trades` are queryable.
- `polymarket.trades` currently covers April 2026 only.


## Template used

https://github.com/triggerdotdev/examples/tree/main/clickhouse-chat-agent
