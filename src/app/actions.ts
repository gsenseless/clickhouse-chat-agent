"use server";

import { auth } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";

const DEBUG_ENABLED = !["0", "false", "off"].includes(
  (process.env.CLICKHOUSE_AGENT_DEBUG ?? "1").trim().toLowerCase()
);

// Creates the Session row + triggers the first run, returns the session PAT.
// Idempotent on (env, chatId) so concurrent calls converge to the same session.
const startChatSessionAction = chat.createStartSessionAction("clickhouse-agent");

export async function startChatSession({
  chatId,
  clientData,
}: {
  chatId: string;
  clientData: unknown;
}) {
  if (DEBUG_ENABLED) {
    console.log("[clickhouse-agent/session-start]", {
      chatId,
      hasClientData: Boolean(clientData),
      at: new Date().toISOString(),
    });
  }
  return startChatSessionAction({ chatId, clientData });
}

// Pure mint — fresh session-scoped PAT for an existing session.
// The transport calls this on 401/403 to refresh.
export async function mintChatAccessToken(chatId: string) {
  if (DEBUG_ENABLED) {
    console.log("[clickhouse-agent/token-mint]", {
      chatId,
      expirationTime: "1h",
      at: new Date().toISOString(),
    });
  }

  return auth.createPublicToken({
    scopes: {
      read: { sessions: chatId },
      write: { sessions: chatId },
    },
    expirationTime: "1h",
  });
}
