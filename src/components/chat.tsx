"use client";

import { useChat } from "@ai-sdk/react";
import { useTriggerChatTransport } from "@trigger.dev/sdk/chat/react";
import type { UIMessage } from "ai";
import { ArrowUp, Loader2, Square } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mintChatAccessToken, startChatSession } from "@/app/actions";
import { normalizeSpec } from "@/lib/catalog";
import { POLYMARKET_LOGO_DATA_URI } from "@/lib/polymarket-logo";
import { Visualization } from "@/components/visualization";
import type { clickhouseAgent } from "@/trigger/clickhouse-agent";

const SUGGESTIONS = [
  "What data do I have?",
  "Show me the top 5 largest trades over $10k on sports markets.",
  "Show me how the probability of Trump winning evolved over time.",
];

const DEBUG_DEFAULT_VISIBLE = ["1", "true", "on"].includes(
  (process.env.NEXT_PUBLIC_CHAT_DEBUG ?? "1").toLowerCase()
);

type ToolDebugPayload = {
  tool?: string;
  status?: "started" | "succeeded" | "failed";
  durationMs?: number;
  inputPreview?: string;
  outputSummary?: string;
  truncated?: boolean;
  error?: string;
};

export function Chat() {
  const transport = useTriggerChatTransport<typeof clickhouseAgent>({
    task: "clickhouse-agent",
    // Only needed when the agent runs somewhere other than cloud.trigger.dev
    // (e.g. self-hosted) — the server-side TRIGGER_API_URL isn't visible in
    // the browser, so the SSE endpoints get their base URL from this.
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    accessToken: ({ chatId }) => mintChatAccessToken(chatId),
    startSession: ({ chatId, clientData }) => startChatSession({ chatId, clientData }),
  });

  const { messages, sendMessage, stop, status } = useChat({ transport });
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(DEBUG_DEFAULT_VISIBLE);
  const busy = status === "submitted" || status === "streaming";

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setInput("");
  }

  return (
    <div className="mx-auto flex h-dvh w-full max-w-4xl flex-col bg-gradient-to-b from-sky-50 via-white to-emerald-50">
      <header className="flex items-center gap-3 border-b border-sky-200/80 bg-white/90 px-4 py-3 backdrop-blur">
        <img
          src={POLYMARKET_LOGO_DATA_URI}
          alt="Polymarket"
          className="h-7 w-7 rounded-md border border-sky-100 bg-white p-1"
        />
        <h1 className="text-sm font-semibold text-slate-900">Polymarket data chat</h1>
        <button
          type="button"
          onClick={() => setShowDebug((v) => !v)}
          className="ml-auto rounded-full border border-sky-200 bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:bg-sky-50 hover:text-slate-900"
          aria-pressed={showDebug}
        >
          {showDebug ? "Hide debug" : "Show debug"}
        </button>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-6 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-sky-200">
        {messages.length === 0 && (
          <div className="mt-16 space-y-4 text-center">
            <p className="text-sm text-slate-600">
              What do you want to know about Polymarket data?
            </p>
            <div className="mx-auto flex max-w-md flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  className="rounded-full border border-sky-200 bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm transition-colors hover:bg-sky-50 hover:text-slate-900"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <Message key={message.id} message={message} showDebug={showDebug} />
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Working…
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="border-t border-sky-200/80 bg-white/90 px-4 py-3 backdrop-blur"
      >
        <div className="flex items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-sky-300/60">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What do you want about Polymarket data?"
            className="flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => stop()}
              className="rounded-lg bg-slate-100 p-2 text-slate-700 transition-colors hover:bg-slate-200"
              aria-label="Stop"
            >
              <Square className="size-3.5" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-lg bg-sky-600 p-2 text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
              aria-label="Send"
            >
              <ArrowUp className="size-3.5" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function Message({ message, showDebug }: { message: UIMessage; showDebug: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
          {message.parts.map((part, i) => (part.type === "text" ? <span key={i}>{part.text}</span> : null))}
        </div>
      </div>
    );
  }

  const toolTimeline = getToolTimeline(message);

  return (
    <div className="space-y-1 text-sm">
      {message.parts.map((part, i) => (
        <MessagePart key={i} part={part} />
      ))}
      {showDebug && toolTimeline.length > 0 && <DebugTimeline entries={toolTimeline} />}
    </div>
  );
}

function MessagePart({ part }: { part: UIMessage["parts"][number] }) {
  if (part.type === "text") {
    return (
      <div className="prose-sm max-w-none leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
      </div>
    );
  }

  if (part.type === "tool-renderVisualization") {
    const input = part.input as { spec?: unknown } | undefined;
    const output = part.output as { ok?: boolean } | undefined;
    const spec = part.state === "input-streaming" ? null : normalizeSpec(input?.spec);

    // Only render completed visualizations in the main transcript.
    // In-progress tool activity is shown via the global Working indicator
    // and the optional debug timeline.
    if (!spec || (output && output.ok === false)) {
      return null;
    }
    return <Visualization spec={spec} />;
  }

  if (part.type === "tool-listTables") {
    return null;
  }

  if (part.type === "tool-describeTable") {
    return null;
  }

  if (part.type === "tool-runQuery") {
    return null;
  }

  return null;
}

function getToolTimeline(message: UIMessage): Array<{
  key: string;
  toolName: string;
  status: string;
  durationMs?: number;
  inputPreview: string;
  outputSummary?: string;
  error?: string;
}> {
  const timeline: Array<{
    key: string;
    toolName: string;
    status: string;
    durationMs?: number;
    inputPreview: string;
    outputSummary?: string;
    error?: string;
  }> = [];

  message.parts.forEach((part, index) => {
    if (!part.type.startsWith("tool-")) {
      return;
    }

    const toolPart = part as {
      type: `tool-${string}`;
      state?: string;
      input?: unknown;
      output?: unknown;
    };
    const toolName = toolPart.type.replace("tool-", "");
    const output = toolPart.output as { debug?: ToolDebugPayload; error?: string } | undefined;
    const debug = output?.debug;

    timeline.push({
      key: `${part.type}-${index}`,
      toolName,
      status:
        debug?.status ??
        (toolPart.state === "output-available"
          ? "succeeded"
          : toolPart.state === "input-streaming"
            ? "planning"
            : "running"),
      durationMs: debug?.durationMs,
      inputPreview: debug?.inputPreview ?? summarizeToolInput(toolName, toolPart.input),
      outputSummary: debug?.outputSummary,
      error: debug?.error ?? output?.error,
    });
  });

  return timeline;
}

function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return "No input";
  }

  if (toolName === "runQuery") {
    const query = (input as { query?: unknown }).query;
    if (typeof query === "string") {
      return truncateOneLine(query, 300);
    }
  }

  if (toolName === "describeTable") {
    const table = (input as { table?: unknown }).table;
    if (typeof table === "string") {
      return `table=${truncateOneLine(table, 120)}`;
    }
  }

  if (toolName === "renderVisualization") {
    const spec = (input as { spec?: unknown }).spec;
    if (spec && typeof spec === "object") {
      const root = (spec as { root?: unknown }).root;
      const elements = (spec as { elements?: Record<string, unknown> }).elements;
      const count = elements && typeof elements === "object" ? Object.keys(elements).length : 0;
      return `root=${typeof root === "string" ? root : "?"}, elements=${count}`;
    }
  }

  try {
    return truncateOneLine(JSON.stringify(input), 240);
  } catch {
    return "[unserializable input]";
  }
}

function truncateOneLine(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

function DebugTimeline({
  entries,
}: {
  entries: Array<{
    key: string;
    toolName: string;
    status: string;
    durationMs?: number;
    inputPreview: string;
    outputSummary?: string;
    error?: string;
  }>;
}) {
  return (
    <details className="my-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2">
      <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground">
        Under the hood ({entries.length} tool step{entries.length === 1 ? "" : "s"})
      </summary>
      <div className="mt-2 space-y-2">
        {entries.map((entry, i) => (
          <div key={entry.key} className="rounded-md bg-background/80 px-2 py-1.5 text-[11px] leading-5">
            <div className="flex items-center gap-2">
              <span className="font-medium">{i + 1}. {entry.toolName}</span>
              <span className="text-muted-foreground">{entry.status}</span>
              {typeof entry.durationMs === "number" && (
                <span className="text-muted-foreground">{entry.durationMs} ms</span>
              )}
            </div>
            <div className="text-muted-foreground">input: {entry.inputPreview}</div>
            {entry.outputSummary && <div className="text-muted-foreground">output: {entry.outputSummary}</div>}
            {entry.error && <div className="text-red-500">error: {entry.error}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}
