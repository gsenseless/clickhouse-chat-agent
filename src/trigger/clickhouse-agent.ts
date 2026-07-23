import { prompts } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { createProviderRegistry, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { catalogPromptSection, normalizeSpec, validateSpec } from "../lib/catalog";
import { polymarketDataContext } from "../lib/polymarket-context";

//const DEFAULT_NIM_MODEL = "moonshotai/kimi-k2.6";
//const DEFAULT_NIM_MODEL = "meta/llama-3.1-8b-instruct";
const DEFAULT_NIM_MODEL = "nvidia/nemotron-3-super-120b-a12b";
// const DEFAULT_NIM_MODEL = "meta/llama-3.3-70b-instruct";

function getNimModelName(): string {
  return process.env.NIM_MODEL?.trim() || DEFAULT_NIM_MODEL;
}

function getNimProvider() {
  const apiKey = process.env.NIM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "NIM_API_KEY is not set. Add it in the Trigger.dev dashboard under Environment Variables."
    );
  }

  return createOpenAICompatible({
    name: "nim",
    baseURL: "https://integrate.api.nvidia.com/v1",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

// ============================================================================
// ClickHouse client (Node.js client, HTTPS interface)
// ============================================================================

// Lazy singleton so the env var is read at run time, where the dashboard's
// environment variables have been injected.
let clickhouse: ClickHouseClient | undefined;

function getClickHouse(): ClickHouseClient {
  if (!clickhouse) {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) {
      throw new Error(
        "CLICKHOUSE_URL is not set. Add it in the Trigger.dev dashboard under Environment Variables, e.g. https://default:password@your-service.clickhouse.cloud:8443"
      );
    }
    clickhouse = createClient({ url });
  }
  return clickhouse;
}

// Keep tool outputs a sane size for the model and the chat stream.
const MAX_OUTPUT_CHARS = 50_000;
const MAX_DEBUG_PREVIEW_CHARS = 300;
const MAX_DEBUG_JSON_CHARS = 800;

const DEBUG_ENABLED = !["0", "false", "off"].includes(
  (process.env.CLICKHOUSE_AGENT_DEBUG ?? "1").trim().toLowerCase()
);

type DebugTrace = {
  tool: string;
  status: "started" | "succeeded" | "failed";
  durationMs?: number;
  inputPreview?: string;
  outputSummary?: string;
  truncated?: boolean;
  error?: string;
};

type ColumnMeta = {
  name: string;
  description?: string;
};

type RowRecord = Record<string, unknown>;

function truncateText(text: string, maxChars = MAX_DEBUG_PREVIEW_CHARS): { text: string; truncated: boolean } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  return { text: `${normalized.slice(0, maxChars)}…`, truncated: true };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function summarizeJson(value: unknown, maxChars = MAX_DEBUG_JSON_CHARS): { summary: string; truncated: boolean } {
  const raw = safeJsonStringify(value);
  if (raw.length <= maxChars) {
    return { summary: raw, truncated: false };
  }
  return { summary: `${raw.slice(0, maxChars)}…`, truncated: true };
}

function logDebug(label: string, payload: unknown) {
  if (!DEBUG_ENABLED) return;
  console.log(`[clickhouse-agent/${label}]`, payload);
}

function logDebugError(label: string, payload: unknown) {
  if (!DEBUG_ENABLED) return;
  console.error(`[clickhouse-agent/${label}]`, payload);
}

function capOutput(rows: unknown[]): { rows: unknown[]; truncated: boolean } {
  let out = rows;
  while (out.length > 1 && JSON.stringify(out).length > MAX_OUTPUT_CHARS) {
    out = out.slice(0, Math.ceil(out.length / 2));
  }
  return { rows: out, truncated: out.length < rows.length };
}

function tokenizeForRelevance(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeColumnName(input: string): string {
  return input.trim().toLowerCase();
}

const COLUMN_FILTER_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "show",
  "list",
  "table",
  "chart",
  "data",
  "rows",
  "column",
  "columns",
  "result",
  "results",
]);

function buildPromptTokenSet(prompt: string): Set<string> {
  const tokens = tokenizeForRelevance(prompt).filter((token) => !COLUMN_FILTER_STOP_WORDS.has(token));
  return new Set(tokens);
}

function scoreColumnRelevance(columnName: string, description: string | undefined, promptTokens: Set<string>): number {
  const nameTokens = tokenizeForRelevance(columnName);
  const descriptionTokens = tokenizeForRelevance(description ?? "");
  const metadataTokens = new Set([...nameTokens, ...descriptionTokens]);

  let score = 0;
  for (const token of promptTokens) {
    if (metadataTokens.has(token)) {
      score += 2;
    }
  }

  const normalizedName = normalizeColumnName(columnName);
  if (promptTokens.has(normalizedName)) {
    score += 3;
  }

  return score;
}

const POLYMARKET_DATABASE = "polymarket";
const ALLOWED_TABLES = new Set(["polymarket.markets", "polymarket.trades"]);

function resolveScopedTable(rawTable: string):
  | { ok: true; database: string; name: string; qualified: string }
  | { ok: false; error: string } {
  const cleaned = rawTable.trim().toLowerCase();
  if (!cleaned) {
    return {
      ok: false,
      error:
        "Table name is required. Allowed tables are polymarket.markets and polymarket.trades.",
    };
  }

  if (cleaned.includes(".")) {
    const [database, name] = cleaned.split(".", 2);
    const qualified = `${database}.${name}`;
    if (!ALLOWED_TABLES.has(qualified)) {
      return {
        ok: false,
        error: `Only polymarket.markets and polymarket.trades are allowed. Rejected table: ${qualified}`,
      };
    }
    return { ok: true, database, name, qualified };
  }

  const qualified = `${POLYMARKET_DATABASE}.${cleaned}`;
  if (!ALLOWED_TABLES.has(qualified)) {
    return {
      ok: false,
      error: `Only polymarket.markets and polymarket.trades are allowed. Rejected table: ${cleaned}`,
    };
  }

  return { ok: true, database: POLYMARKET_DATABASE, name: cleaned, qualified };
}

function stripSqlCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/'([^'\\]|\\.)*'/g, " ");
}

function extractTableReferences(sql: string): string[] {
  const cleaned = stripSqlCommentsAndStrings(sql).toLowerCase();
  const refs = new Set<string>();
  const pattern = /\b(?:from|join|describe\s+table|exists\s+table)\s+([a-z_][\w]*(?:\.[a-z_][\w]*)?)/gi;
  let match: RegExpExecArray | null = pattern.exec(cleaned);

  while (match) {
    refs.add(match[1]);
    match = pattern.exec(cleaned);
  }

  return [...refs];
}

function extractCteNames(sql: string): Set<string> {
  const cleaned = stripSqlCommentsAndStrings(sql).toLowerCase();
  const ctes = new Set<string>();
  const pattern = /\bwith\s+([a-z_][\w]*)\s+as\s*\(|,\s*([a-z_][\w]*)\s+as\s*\(/gi;
  let match: RegExpExecArray | null = pattern.exec(cleaned);

  while (match) {
    const cteName = match[1] ?? match[2];
    if (cteName) {
      ctes.add(cteName);
    }
    match = pattern.exec(cleaned);
  }

  return ctes;
}

// ============================================================================
// Tools
// ============================================================================

const describeTable = tool({
  description:
    "Get the schema (column names and types) of an allowed Polymarket table. Allowed tables are polymarket.markets and polymarket.trades.",
  inputSchema: z.object({
    table: z
      .string()
      .describe("Table name: polymarket.markets or polymarket.trades. Unqualified names markets/trades are accepted."),
  }),
  execute: async ({ table }) => {
    const startedAt = Date.now();
    const tablePreview = truncateText(table);
    logDebug("tool-start", {
      tool: "describeTable",
      input: { table: tablePreview.text, truncated: tablePreview.truncated },
    });

    const scopedTable = resolveScopedTable(table);
    if (!scopedTable.ok) {
      const durationMs = Date.now() - startedAt;
      logDebug("tool-success", {
        tool: "describeTable",
        durationMs,
        table: tablePreview.text,
        tableTruncated: tablePreview.truncated,
        scopeRejected: true,
      });
      return {
        error: scopedTable.error,
        debug: {
          tool: "describeTable",
          status: "failed",
          durationMs,
          inputPreview: tablePreview.text,
          truncated: tablePreview.truncated,
          error: scopedTable.error,
        } satisfies DebugTrace,
      };
    }

    try {
      const result = await getClickHouse().query({
        query: "DESCRIBE TABLE {database: Identifier}.{name: Identifier}",
        query_params: { database: scopedTable.database, name: scopedTable.name },
        format: "JSONEachRow",
      });
      const columns = await result.json();
      const durationMs = Date.now() - startedAt;
      logDebug("tool-success", {
        tool: "describeTable",
        durationMs,
        table: tablePreview.text,
        tableTruncated: tablePreview.truncated,
        columnCount: columns.length,
      });

      return {
        columns,
        debug: {
          tool: "describeTable",
          status: "succeeded",
          durationMs,
          inputPreview: tablePreview.text,
          outputSummary: `Returned ${columns.length} columns`,
          truncated: tablePreview.truncated,
        } satisfies DebugTrace,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logDebugError("tool-error", {
        tool: "describeTable",
        durationMs,
        table: tablePreview.text,
        tableTruncated: tablePreview.truncated,
        error: errorMessage,
      });
      return {
        error: errorMessage,
        debug: {
          tool: "describeTable",
          status: "failed",
          durationMs,
          inputPreview: tablePreview.text,
          truncated: tablePreview.truncated,
          error: errorMessage,
        } satisfies DebugTrace,
      };
    }
  },
});

const READ_ONLY_STATEMENTS = /^\s*(select|with|describe|desc|explain|exists)\b/i;

const runQuery = tool({
  description:
    "Run a read-only SQL query against ClickHouse for polymarket.markets and polymarket.trades only. " +
    "Only SELECT-style statements are allowed. Always include a LIMIT (at most 100 rows) " +
    "unless the query is an aggregation.",
  inputSchema: z.object({
    query: z.string().describe("The ClickHouse SQL query to run"),
  }),
  execute: async ({ query }) => {
    const startedAt = Date.now();
    const queryPreview = truncateText(query);
    logDebug("tool-start", {
      tool: "runQuery",
      input: { queryPreview: queryPreview.text, truncated: queryPreview.truncated },
    });

    if (!READ_ONLY_STATEMENTS.test(query)) {
      const durationMs = Date.now() - startedAt;
      logDebug("tool-success", {
        tool: "runQuery",
        durationMs,
        readonlyRejected: true,
        queryPreview: queryPreview.text,
      });
      return {
        error:
          "Only read-only statements (SELECT, WITH, DESCRIBE, EXPLAIN, EXISTS) are allowed.",
        debug: {
          tool: "runQuery",
          status: "failed",
          durationMs,
          inputPreview: queryPreview.text,
          truncated: queryPreview.truncated,
          error:
            "Only read-only statements (SELECT, WITH, DESCRIBE, EXPLAIN, EXISTS) are allowed.",
        } satisfies DebugTrace,
      };
    }

    const cteNames = extractCteNames(query);
    const referencedTables = extractTableReferences(query).filter(
      (tableRef) => !cteNames.has(tableRef)
    );
    for (const tableRef of referencedTables) {
      const resolved = resolveScopedTable(tableRef);
      if (!resolved.ok) {
        const durationMs = Date.now() - startedAt;
        logDebug("tool-success", {
          tool: "runQuery",
          durationMs,
          queryPreview: queryPreview.text,
          queryTruncated: queryPreview.truncated,
          scopeRejected: true,
          tableRef,
        });
        return {
          error: resolved.error,
          debug: {
            tool: "runQuery",
            status: "failed",
            durationMs,
            inputPreview: queryPreview.text,
            truncated: queryPreview.truncated,
            error: resolved.error,
          } satisfies DebugTrace,
        };
      }
    }

    try {
      const result = await getClickHouse().query({
        query,
        format: "JSONEachRow",
        clickhouse_settings: {
          // readonly=2: reads only (no writes/DDL), but per-query settings like
          // the limits below are still allowed.
          readonly: "2",
          max_result_rows: "1000",
          result_overflow_mode: "break",
          max_execution_time: 30,
        },
      });

      const rows = await result.json();
      const capped = capOutput(rows);
      const durationMs = Date.now() - startedAt;
      const outputSummary = `Returned ${rows.length} rows${capped.truncated ? " (truncated)" : ""}`;
      logDebug("tool-success", {
        tool: "runQuery",
        durationMs,
        queryPreview: queryPreview.text,
        queryTruncated: queryPreview.truncated,
        rowCount: rows.length,
        truncated: capped.truncated,
      });

      return {
        rowCount: rows.length,
        rows: capped.rows,
        ...(capped.truncated ? { note: "Result truncated — refine the query or aggregate." } : {}),
        debug: {
          tool: "runQuery",
          status: "succeeded",
          durationMs,
          inputPreview: queryPreview.text,
          outputSummary,
          truncated: queryPreview.truncated || capped.truncated,
        } satisfies DebugTrace,
      };
    } catch (error) {
      // Return ClickHouse errors to the model so it can fix the query and retry.
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorPreview = truncateText(errorMessage, 500);
      logDebugError("tool-error", {
        tool: "runQuery",
        durationMs,
        queryPreview: queryPreview.text,
        queryTruncated: queryPreview.truncated,
        error: errorPreview.text,
        errorTruncated: errorPreview.truncated,
      });
      return {
        error: errorMessage,
        debug: {
          tool: "runQuery",
          status: "failed",
          durationMs,
          inputPreview: queryPreview.text,
          truncated: queryPreview.truncated || errorPreview.truncated,
          error: errorPreview.text,
        } satisfies DebugTrace,
      };
    }
  },
});

// The UI spec the model passes here is rendered in the Next.js app with
// json-render + shadcn components. Validation errors are returned to the
// model so it can fix the spec and retry.
const renderVisualization = tool({
  description:
    "Render charts, tables and stat cards for the user, instead of describing data as text. " +
    "Pass a structured json-render spec object (not a JSON string) built from the components listed " +
    "in the system prompt, with the data rows inlined. Use whenever an answer contains tabular data, " +
    "a trend, a comparison or a headline number.",
  inputSchema: z.object({
    spec: z
      .union([
        z.object({
          root: z.string().describe("Key of the root element"),
          elements: z.record(
            z.string(),
            z.object({
              type: z.string().describe("A component name from the system prompt"),
              props: z.record(z.string(), z.unknown()),
              children: z.array(z.string()).optional().describe("Keys of child elements"),
            })
          ),
        }),
        z.string(),
      ])
      .describe(
        "Visualization spec payload. Pass a structured object with { root, elements }. Do not pass a JSON string."
      ),
  }),
  execute: async ({ spec }) => {
    const startedAt = Date.now();
    const inputSummary =
      typeof spec === "string"
        ? summarizeJson(
            {
              specType: "string",
              specPreview: truncateText(spec, 300).text,
            },
            300
          )
        : summarizeJson(
            {
              specType: "object",
              root: spec.root,
              elementCount: Object.keys(spec.elements ?? {}).length,
            },
            300
          );
    logDebug("tool-start", {
      tool: "renderVisualization",
      inputSummary: inputSummary.summary,
      inputSummaryTruncated: inputSummary.truncated,
    });

    if (typeof spec === "string") {
      const durationMs = Date.now() - startedAt;
      const errorMessage =
        "renderVisualization requires spec as an object, not a string. Pass spec directly as { root, elements } and do not JSON.stringify it.";
      logDebug("tool-success", {
        tool: "renderVisualization",
        durationMs,
        validationFailed: true,
        rejectedSpecType: "string",
      });
      return {
        ok: false,
        errors: [errorMessage],
        debug: {
          tool: "renderVisualization",
          status: "failed",
          durationMs,
          inputPreview: inputSummary.summary,
          truncated: inputSummary.truncated,
          error: errorMessage,
        } satisfies DebugTrace,
      };
    }

    const normalized = normalizeSpec(spec);
    if (!normalized) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = 'spec must be an object of the form { root: "<key>", elements: { ... } }';
      logDebug("tool-success", {
        tool: "renderVisualization",
        durationMs,
        validationFailed: true,
      });
      return {
        ok: false,
        errors: [errorMessage],
        debug: {
          tool: "renderVisualization",
          status: "failed",
          durationMs,
          inputPreview: inputSummary.summary,
          truncated: inputSummary.truncated,
          error: errorMessage,
        } satisfies DebugTrace,
      };
    }
    const result = validateSpec(normalized);
    if (!result.ok) {
      // Surfaces in the run log — handy when tuning the catalog or prompt.
      console.warn("renderVisualization spec rejected:", result.errors);
      const durationMs = Date.now() - startedAt;
      const summarizedErrors = truncateText(result.errors.join("; "), 500);
      logDebug("tool-success", {
        tool: "renderVisualization",
        durationMs,
        validationFailed: true,
        errors: summarizedErrors.text,
        errorsTruncated: summarizedErrors.truncated,
      });
      return {
        ok: false,
        errors: result.errors,
        debug: {
          tool: "renderVisualization",
          status: "failed",
          durationMs,
          inputPreview: inputSummary.summary,
          truncated: inputSummary.truncated || summarizedErrors.truncated,
          error: summarizedErrors.text,
        } satisfies DebugTrace,
      };
    }
    const durationMs = Date.now() - startedAt;
    logDebug("tool-success", {
      tool: "renderVisualization",
      durationMs,
      root: normalized.root,
      elementCount: Object.keys(normalized.elements).length,
    });
    return {
      ok: true,
      note: "Rendered to the user. Don't repeat the data as text — add at most a one-sentence takeaway.",
      debug: {
        tool: "renderVisualization",
        status: "succeeded",
        durationMs,
        inputPreview: inputSummary.summary,
        outputSummary: `Rendered ${Object.keys(normalized.elements).length} elements`,
        truncated: inputSummary.truncated,
      } satisfies DebugTrace,
    };
  },
});

// Column-only filtering tool used before visualization. Relevance is based
// only on prompt text + column metadata and never on row values.
const filterColumnsForVisualization = tool({
  description:
    "Filter visualization input by dropping irrelevant columns while preserving all rows. " +
    "Relevance must be computed from user prompt + column names/descriptions only; never use row values.",
  inputSchema: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).describe("Query result rows to project to relevant columns"),
    userPrompt: z.string().describe("Original user request that determines which columns are relevant"),
    columnsMeta: z
      .array(
        z.object({
          name: z.string().describe("Column name"),
          description: z.string().optional().describe("Optional column description or comment"),
        })
      )
      .optional()
      .describe("Optional column metadata. Use describeTable output when available."),
    includeColumns: z
      .array(z.string())
      .optional()
      .describe("Optional explicit allow-list of columns to keep"),
    excludeColumns: z
      .array(z.string())
      .optional()
      .describe("Optional explicit deny-list of columns to remove"),
  }),
  execute: async ({ rows, userPrompt, columnsMeta, includeColumns, excludeColumns }) => {
    const startedAt = Date.now();
    const inputSummary = summarizeJson(
      {
        rowCount: rows.length,
        userPrompt,
        columnsMetaCount: columnsMeta?.length ?? 0,
        includeColumnsCount: includeColumns?.length ?? 0,
        excludeColumnsCount: excludeColumns?.length ?? 0,
      },
      400
    );
    logDebug("tool-start", {
      tool: "filterColumnsForVisualization",
      inputSummary: inputSummary.summary,
      inputSummaryTruncated: inputSummary.truncated,
    });

    try {
      const detectedColumns = new Set<string>();
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          detectedColumns.add(key);
        }
      }

      const allColumns = [...detectedColumns];
      const promptTokens = buildPromptTokenSet(userPrompt);
      const includeSet = new Set((includeColumns ?? []).map(normalizeColumnName));
      const excludeSet = new Set((excludeColumns ?? []).map(normalizeColumnName));
      const metaByColumn = new Map<string, ColumnMeta>();

      for (const meta of columnsMeta ?? []) {
        metaByColumn.set(normalizeColumnName(meta.name), meta);
      }

      let keptColumns: string[];

      if (includeSet.size > 0) {
        keptColumns = allColumns.filter((column) => includeSet.has(normalizeColumnName(column)));
      } else {
        keptColumns = allColumns.filter((column) => {
          const normalized = normalizeColumnName(column);
          if (excludeSet.has(normalized)) {
            return false;
          }

          const meta = metaByColumn.get(normalized);
          return scoreColumnRelevance(column, meta?.description, promptTokens) > 0;
        });

        // Safe fallback to avoid empty projections in ambiguous prompts.
        if (keptColumns.length === 0) {
          keptColumns = [...allColumns];
        }
      }

      keptColumns = keptColumns.filter((column) => !excludeSet.has(normalizeColumnName(column)));
      if (keptColumns.length === 0) {
        keptColumns = [...allColumns];
      }

      const keptNormalized = new Set(keptColumns.map(normalizeColumnName));
      const filteredRows: RowRecord[] = rows.map((row) => {
        const projected: RowRecord = {};
        for (const key of Object.keys(row)) {
          if (keptNormalized.has(normalizeColumnName(key))) {
            projected[key] = row[key];
          }
        }
        return projected;
      });

      const removedColumns = allColumns.filter((column) => !keptNormalized.has(normalizeColumnName(column)));
      const durationMs = Date.now() - startedAt;
      logDebug("tool-success", {
        tool: "filterColumnsForVisualization",
        durationMs,
        rowCountBefore: rows.length,
        rowCountAfter: filteredRows.length,
        totalColumns: allColumns.length,
        keptColumns: keptColumns.length,
        removedColumns: removedColumns.length,
        usedDescriptions: (columnsMeta?.length ?? 0) > 0,
      });

      return {
        rowCountBefore: rows.length,
        rowCountAfter: filteredRows.length,
        rows: filteredRows,
        keptColumns,
        removedColumns,
        note:
          (columnsMeta?.length ?? 0) > 0
            ? "Columns filtered using prompt relevance + column names/descriptions; rows preserved."
            : "Columns filtered using prompt relevance + column names only (no descriptions provided); rows preserved.",
        debug: {
          tool: "filterColumnsForVisualization",
          status: "succeeded",
          durationMs,
          inputPreview: inputSummary.summary,
          outputSummary: `Projected ${allColumns.length} columns to ${keptColumns.length}; rows unchanged (${rows.length})`,
          truncated: inputSummary.truncated,
        } satisfies DebugTrace,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorPreview = truncateText(errorMessage, 500);
      logDebugError("tool-error", {
        tool: "filterColumnsForVisualization",
        durationMs,
        error: errorPreview.text,
        errorTruncated: errorPreview.truncated,
      });

      return {
        error: errorMessage,
        debug: {
          tool: "filterColumnsForVisualization",
          status: "failed",
          durationMs,
          inputPreview: inputSummary.summary,
          truncated: inputSummary.truncated || errorPreview.truncated,
          error: errorPreview.text,
        } satisfies DebugTrace,
      };
    }
  },
});

const tools = { describeTable, runQuery, filterColumnsForVisualization, renderVisualization };

// ============================================================================
// The chat agent
// ============================================================================

// A versioned AI Prompt: edit or override the analyst guidance (and model/
// temperature) from the dashboard without redeploying. The json-render
// component reference is generated from the catalog at run time and injected
// as a template variable, so it always matches the deployed code.
const systemPrompt = prompts.define({
  id: "clickhouse-analyst",
  description: "System prompt for the ClickHouse data-analyst chat agent",
  model: `nim:${getNimModelName()}`,
  variables: z.object({
    componentReference: z.string(),
    dataReference: z.string(),
  }),
  content: `You are a Polymarket data analyst for a ClickHouse backend.
You can only use these two tables:
- polymarket.markets
- polymarket.trades

Guidelines:
- Never query or describe any other table. If the user asks for other tables, explain that only polymarket.markets and polymarket.trades are in scope.
- Use describeTable when schema details are needed before writing SQL.
- Write ClickHouse SQL (not Postgres/MySQL dialect). Prefer aggregations over fetching raw rows.
- While searching for relevant markets, use two stage approach: first run a keyword(s) search on event_title, then filter the results based on "question" column. Use more relevant keywords. If results are empty, repeat search with fewer keywords. If still empty, return a message that no relevant markets were found.
- For keyword search on polymarket.markets text columns, use ClickHouse text-index token functions: hasToken, hasAnyTokens, hasAllTokens.
- For keyword search on question/event_title, do not use match() or regexp and prefer token functions over LIKE.
- Always wrap indexed text columns with lower(...) in token search predicates so the text index is used: lower(question), lower(event_title).
- Always LIMIT raw-row queries to 100 rows or fewer.
- If a query fails, read the error, fix the SQL, and retry.
- If a question needs data outside the loaded scope (months beyond April 2026), say this clearly and do not fabricate an answer.

Text-search examples (polymarket.markets):
- All keywords required (AND):
  SELECT id, question FROM polymarket.markets
  WHERE hasAllTokens(lower(question), ['election', '2028'])
- Any of several keywords (OR):
  SELECT id, question FROM polymarket.markets
  WHERE hasAnyTokens(lower(question), 'bitcoin ethereum solana')

## Polymarket data reference

{{dataReference}}

Presenting results:
- Whenever the answer contains tabular data, a trend, a comparison or a headline number, use this sequence: runQuery -> filterColumnsForVisualization -> renderVisualization.
- In filterColumnsForVisualization, filter only columns (never rows). Decide relevance only from the user prompt and column names/descriptions; never from row values.
- When calling renderVisualization, pass spec as a structured object in tool arguments (never as a JSON string).
- For ranking asks, drop irrelevant columns (for example Maker, Taker, IDs, or Trade Time) unless explicitly requested by the user.
- Then call renderVisualization instead of writing the data out as text: LineChart/AreaChart for time series, BarChart for rankings and comparisons, PieChart for share-of-total, Table for detail rows, a Grid of Stats for KPIs, PointMap for geographic questions when the data has coordinates (aggregate to at most ~200 points in SQL, e.g. round coordinates and count).
- Compose visualizations inside a Card with a title; put multiple related views in one spec (e.g. a Stat row above a chart).
- Keep chart data to a reasonable number of points (aggregate in SQL first) and pre-format display values (round numbers, currency symbols) in the props.
- After rendering you may add one-two sentences, if there is some important additional information. Never repeat data.

## renderVisualization spec reference

{{componentReference}}`,
});

export const clickhouseAgent = chat.agent({
  id: "clickhouse-agent",
  idleTimeoutInSeconds: 300,

  // Declared on the config so tool results survive history re-conversion
  // across turns; the resolved set comes back typed on the run payload.
  tools,

  onChatStart: async () => {
    // Resolves the latest prompt version (or an active dashboard override)
    // and stores it for the run. chat.toStreamTextOptions() picks up the
    // system text, model, config AND experimental_telemetry from it — the
    // telemetry is what links model-call spans to the prompt and makes LLM
    // observability (tokens, cost, latency) show up in the dashboard.
    const resolved = await systemPrompt.resolve({
      componentReference: catalogPromptSection(),
      dataReference: polymarketDataContext(),
    });
    chat.prompt.set(resolved);
  },

  run: async ({ messages, tools, signal }) => {
    const nim = getNimProvider();
    const registry = createProviderRegistry({ nim });
    const runStartedAt = Date.now();

    // Lightweight debug logging to help correlate client requests with runs.
    try {
      const firstUser = messages.find((m: any) => m.role === "user");
      const promptSnippet = firstUser ? (firstUser.content?.slice?.(0, 200) ?? JSON.stringify(firstUser)) : "";
      logDebug("run-start", {
        messages: messages.length,
        promptSnippet,
        tools: Object.keys(tools || {}).join(","),
        aborted: !!(signal && (signal as AbortSignal).aborted),
      });
    } catch (err) {
      console.warn("[clickhouse-agent] debug log failed", err);
    }

    return streamText({
      // Fallback model only — placed BEFORE the spread so the stored
      // prompt's model (including dashboard overrides) wins when set.
      model: nim.chatModel(getNimModelName()),
      // Spread chat.toStreamTextOptions() — it wires up prepareStep
      // (compaction, steering, background injection), plus the system
      // prompt + model + config + telemetry from chat.prompt().
      // Skipping this is the single most common cause of subtle bugs
      // (silent broken compaction, missing LLM observability, etc.).
      ...chat.toStreamTextOptions({ registry }),
      messages,
      tools,
      stopWhen: stepCountIs(25),
      abortSignal: signal,
      onFinish: ({ finishReason, usage, totalUsage }) => {
        logDebug("run-finish", {
          durationMs: Date.now() - runStartedAt,
          finishReason,
          usage,
          totalUsage,
          aborted: !!(signal && (signal as AbortSignal).aborted),
        });
      },
    });
  },
});
