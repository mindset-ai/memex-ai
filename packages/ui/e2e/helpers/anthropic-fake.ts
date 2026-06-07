// Playwright helpers for driving the server-side Anthropic fake queue over HTTP.
// Requires the server to run with MEMEX_ANTHROPIC_FAKE=1 (set in playwright.config.ts).
// See packages/server/src/agent/anthropic-fake.ts + packages/server/src/routes/__test__.ts.

// Default tracks E2E_SERVER_PORT so a port override moves the helpers with the
// server (overriding one without the other sent every request to a dead port).
const API_URL =
  process.env.E2E_API_URL ??
  `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

export type FakeContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

export interface QueuedResponse {
  textDeltas: string[];
  content: FakeContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  deltaDelayMs?: number;
}

export async function queueAnthropicResponse(
  response: QueuedResponse
): Promise<void> {
  const res = await fetch(`${API_URL}/api/__test__/anthropic-queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to queue fake Anthropic response (${res.status}): ${text}`
    );
  }
}

export async function clearAnthropicQueue(): Promise<void> {
  const res = await fetch(`${API_URL}/api/__test__/anthropic-queue`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`Failed to clear Anthropic queue (${res.status})`);
  }
}
