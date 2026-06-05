import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock the Anthropic client before importing the router.
// The mocked `messages.stream(...)` returns a fake object that mirrors the
// real SDK's MessageStream surface we use: `.on("text", cb)` + `.finalMessage()`.
const mockStream = vi.hoisted(() => vi.fn());

vi.mock("../agent/anthropic-client.js", () => ({
  getAnthropicClient: () => ({ messages: { stream: mockStream } }),
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
}));

vi.mock("../agent/context-builder.js", () => ({
  buildDocumentContext: vi.fn().mockResolvedValue({ context: "ctx", phase: "plan" }),
}));

vi.mock("../agent/system-prompt.js", () => ({
  buildSystemBlocks: vi.fn().mockReturnValue([{ type: "text", text: "s" }]),
  buildCreationSystemBlocks: vi.fn().mockReturnValue([{ type: "text", text: "s" }]),
}));

vi.mock("../agent/tools.js", () => ({
  getToolDefinitions: vi.fn().mockReturnValue([]),
  getCreationToolDefinitions: vi.fn().mockReturnValue([]),
  executeServerTool: vi.fn(),
  isUiTool: vi.fn().mockReturnValue(false),
}));

vi.mock("../services/conversations.js", () => ({
  getOrCreateConversation: vi.fn().mockResolvedValue({ id: "conv-1" }),
  getMessages: vi.fn().mockResolvedValue([]),
  clearConversation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/connection.js", () => ({
  db: {
    delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
  },
}));

vi.mock("../db/schema.js", () => ({
  messages: { conversationId: "conversationId" },
  // The worktree's llm.ts imports mcp/auth.js (canWriteMemex), which references
  // these tables via the relational query builder / eq(). They only need to
  // exist as truthy stubs here — these streaming tests never exercise the
  // visibility gate, but module evaluation pulls the imports in.
  namespaces: {},
  memexes: {},
  orgs: {},
  documents: {},
  decisions: {},
  tasks: {},
  docSections: {},
  docComments: {},
  orgMemberships: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn().mockReturnValue("eq-cond"),
}));

vi.mock("../services/shared/sequence.js", () => ({
  nextSeq: vi.fn().mockResolvedValue(1),
}));

import { llmRouter } from "./llm.js";

/**
 * A controllable mock of the Anthropic MessageStream. Lets the test fire
 * `.on("text", cb)` events and resolve `finalMessage()` on demand, so we can
 * observe exactly when each text_delta leaves the server via the SSE body.
 */
function makeControllableStream() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  let resolveFinal!: (msg: unknown) => void;
  const finalPromise = new Promise((resolve) => {
    resolveFinal = resolve;
  });

  const stream = {
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return stream;
    },
    finalMessage: () => finalPromise,
    // Test-only helpers
    emitText(text: string) {
      listeners.text?.forEach((cb) => cb(text));
    },
    complete(message: unknown) {
      resolveFinal(message);
    },
  };

  return stream;
}

function createTestApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user" as never, { id: "u", email: "u@x", status: "active" });
    c.set("currentAccount" as never, { id: "acc-1" });
    await next();
  });
  app.route("/llm", llmRouter);
  return app;
}

/**
 * Read one SSE frame (ends with a blank line) from a stream reader.
 * Returns null if the stream ends.
 */
async function readSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: { value: string }
): Promise<string | null> {
  while (!buffer.value.includes("\n\n")) {
    const { done, value } = await reader.read();
    if (done) return null;
    buffer.value += decoder.decode(value, { stream: true });
  }
  const idx = buffer.value.indexOf("\n\n");
  const frame = buffer.value.slice(0, idx);
  buffer.value = buffer.value.slice(idx + 2);
  return frame;
}

function parseFrame(frame: string): { event: string; data: string } {
  const lines = frame.split("\n");
  let event = "";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  return { event, data };
}

describe("POST /llm/chat/create — streaming", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("streams each text_delta to the client BEFORE the final message is known", async () => {
    const anthropicMock = makeControllableStream();
    mockStream.mockReturnValue(anthropicMock);

    const res = await app.request("/llm/chat/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const buf = { value: "" };

    // Fire first delta and verify the client can read it immediately —
    // BEFORE we complete the upstream stream. This is the whole point of
    // streaming: text_deltas must be flushed to the client as they arrive,
    // not batched until finalMessage resolves.
    anthropicMock.emitText("Hello ");
    const frame1 = await readSseFrame(reader, decoder, buf);
    expect(frame1).not.toBeNull();
    const parsed1 = parseFrame(frame1!);
    expect(parsed1.event).toBe("text_delta");
    expect(JSON.parse(parsed1.data)).toEqual({ text: "Hello " });

    // Second delta — again must be received before the upstream completes.
    anthropicMock.emitText("world!");
    const frame2 = await readSseFrame(reader, decoder, buf);
    const parsed2 = parseFrame(frame2!);
    expect(parsed2.event).toBe("text_delta");
    expect(JSON.parse(parsed2.data)).toEqual({ text: "world!" });

    // Now complete the upstream and verify the final message frame lands.
    anthropicMock.complete({
      content: [{ type: "text", text: "Hello world!" }],
      stop_reason: "end_turn",
    });

    const frame3 = await readSseFrame(reader, decoder, buf);
    const parsed3 = parseFrame(frame3!);
    expect(parsed3.event).toBe("message_complete");
    const final = JSON.parse(parsed3.data);
    expect(final.stopReason).toBe("end_turn");
    expect(final.content).toEqual([{ type: "text", text: "Hello world!" }]);

    reader.cancel();
  });

  it("streams many rapid deltas without batching", async () => {
    const anthropicMock = makeControllableStream();
    mockStream.mockReturnValue(anthropicMock);

    const res = await app.request("/llm/chat/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const buf = { value: "" };

    // Emit 8 rapid deltas one at a time, draining each into the reader
    // between emissions. If the server batched them, the loop would hang
    // on the second read (nothing queued) until we completed the stream.
    const received: string[] = [];
    for (const token of ["I", "'m", " ", "a", " ", "robot", "!", " "]) {
      anthropicMock.emitText(token);
      const frame = await readSseFrame(reader, decoder, buf);
      const parsed = parseFrame(frame!);
      expect(parsed.event).toBe("text_delta");
      received.push(JSON.parse(parsed.data).text);
    }

    expect(received.join("")).toBe("I'm a robot! ");

    anthropicMock.complete({
      content: [{ type: "text", text: "I'm a robot! " }],
      stop_reason: "end_turn",
    });

    const finalFrame = await readSseFrame(reader, decoder, buf);
    expect(parseFrame(finalFrame!).event).toBe("message_complete");

    reader.cancel();
  });
});
