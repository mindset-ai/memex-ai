// spec-190 t-3 (dec-1/dec-2/dec-4) — the guide's LLM text leg: POST /voice/guide-chat.
// Proves the server SSE proxy streams the guide turn (ac-11: server SSE proxy for
// the client-side graph, no server-side graph runtime), injects the screen context
// into the system prompt, and sends ONLY the guide toolset — no product-data tools
// (ac-28). The Anthropic client is mocked, so this is a pure route unit test.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";
import { GUIDE_TOOLS } from "@memex/shared";

const AC11 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-11";
const AC28 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-28";

// Capture what the route hands Anthropic so we can assert tools + system prompt.
const streamArgs = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("../agent/anthropic-client.js", () => ({
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
  getAnthropicClient: () => ({
    messages: {
      stream: (args: Record<string, unknown>) => {
        streamArgs.last = args;
        return {
          // Route registers .on('text', cb) then awaits finalMessage(); firing
          // synchronously here guarantees the text_delta is written first.
          on(event: string, cb: (t: string) => void) {
            if (event === "text") cb("This is the Specs board.");
            return this;
          },
          finalMessage: async () => ({
            content: [{ type: "text", text: "This is the Specs board." }],
            stop_reason: "end_turn",
          }),
        };
      },
    },
  }),
}));

import { createVoiceRouter } from "./voice.js";

// createVoiceRouter wires a WS route via upgradeWebSocket; we only exercise the
// HTTP POST, so a no-op upgrade that registers a passthrough handler suffices.
const stubUpgrade = ((_handler: unknown) => async (_c: unknown, next: () => Promise<void>) =>
  next()) as unknown as Parameters<typeof createVoiceRouter>[0];

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/ns/mx/voice", createVoiceRouter(stubUpgrade));
  return app;
}

async function postGuideChat(body: unknown): Promise<{ status: number; text: string }> {
  const app = makeApp();
  const res = await app.request("/api/ns/mx/voice/guide-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

beforeEach(() => {
  streamArgs.last = null;
});

describe("POST /voice/guide-chat — guide LLM text leg (ac-11)", () => {
  it("streams text_delta then message_complete over SSE", async () => {
    tagAc(AC11);
    const { status, text } = await postGuideChat({
      messages: [{ role: "user", content: "what is this screen?" }],
      screenKey: "specs-list",
      screenRegistry: [{ id: "new-spec-button", description: "Creates a new Spec." }],
      guideContext: ["The Specs board lists every active spec."],
    });
    expect(status).toBe(200);
    expect(text).toContain("event: text_delta");
    expect(text).toContain("This is the Specs board.");
    expect(text).toContain("event: message_complete");
  });

  it("injects the screen context (screenKey + elements + guide content) into the system prompt", async () => {
    tagAc(AC11);
    await postGuideChat({
      messages: [{ role: "user", content: "explain" }],
      screenKey: "specs-list",
      screenRegistry: [{ id: "new-spec-button", description: "Creates a new Spec." }],
      guideContext: ["The Specs board lists every active spec."],
    });
    const system = JSON.stringify(streamArgs.last?.system ?? []);
    expect(system).toContain("specs-list");
    expect(system).toContain("new-spec-button");
    expect(system).toContain("lists every active spec");
  });

  it("rejects a malformed body with 400", async () => {
    tagAc(AC11);
    const { status } = await postGuideChat({ not: "valid" });
    expect(status).toBe(400);
  });
});

describe("POST /voice/guide-chat — toolset has no product-data tools (ac-28)", () => {
  it("sends ONLY the guide toolset (highlight / navigate / search_guide), no memex/data tools", async () => {
    tagAc(AC28);
    await postGuideChat({
      messages: [{ role: "user", content: "take me to the spec about onboarding" }],
      screenKey: "specs-list",
    });
    const tools = streamArgs.last?.tools as Array<{ name: string }>;
    expect(tools).toBeTruthy();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...GUIDE_TOOLS.map((t) => t.name)].sort());
    // The load-bearing assertion (dec-4): no tenant-data tools leak in.
    for (const forbidden of ["search_memex", "get_doc", "list_docs", "create_doc"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
