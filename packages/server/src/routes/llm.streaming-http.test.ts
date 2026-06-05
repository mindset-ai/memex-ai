import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

// ──────────────────────────────────────────────────────────────
// Setup identical to llm.streaming.test.ts, except this variant
// stands up a real HTTP server with @hono/node-server and reads
// the response over a real TCP socket via `fetch`. The existing
// `app.request(...)` test reads the TransformStream's readable
// side DIRECTLY — it never exercises the Node HTTP layer, so any
// buffering introduced between Hono and the socket is invisible
// to it. This test closes that gap and proves whether a user's
// browser actually sees text_delta events arrive progressively.
// ──────────────────────────────────────────────────────────────

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
 * A controllable Anthropic mock that fires `text` events on demand and lets the
 * test resolve `finalMessage()` when it's ready.
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
 * Start a real HTTP server on an ephemeral port so we can hit it with fetch
 * and observe how text_deltas actually arrive over the wire.
 */
async function startRealServer(app: Hono) {
  const server = serve({ fetch: app.fetch, port: 0 });
  // @hono/node-server exposes the underlying http.Server synchronously once serve()
  // has bound the listener. Wait a tick to be safe, then read the port.
  await new Promise((r) => setImmediate(r));
  const addr = (server as unknown as { address: () => AddressInfo }).address();
  return { server, port: addr.port };
}

async function readSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: { value: string },
  timeoutMs = 2000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (!buffer.value.includes("\n\n")) {
    if (Date.now() > deadline) return null;
    const readPromise = reader.read();
    const timer = new Promise<{ done: true; value: undefined }>((res) =>
      setTimeout(() => res({ done: true, value: undefined }), deadline - Date.now())
    );
    const result = await Promise.race([readPromise, timer]);
    if (result.done) return null;
    buffer.value += decoder.decode(result.value, { stream: true });
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

describe("POST /llm/chat/create — real HTTP streaming", () => {
  let server: ReturnType<typeof serve>;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = createTestApp();
    const started = await startRealServer(app);
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it("delivers each text_delta to the socket BEFORE finalMessage resolves", async () => {
    const anthropicMock = makeControllableStream();
    mockStream.mockReturnValue(anthropicMock);

    const res = await fetch(`http://127.0.0.1:${port}/llm/chat/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const buf = { value: "" };

    // Give the server handler a moment to register its `on("text", ...)` listener
    // before we start firing deltas into the mock. Without this the first emit
    // can race the route handler startup and land before any listener exists.
    await new Promise((r) => setTimeout(r, 50));

    // The whole point of streaming: a delta emitted NOW should land on the wire
    // NOW, not once finalMessage() resolves. If the handler buffers writes until
    // cb(stream) returns, this read will time out.
    anthropicMock.emitText("first ");
    const frame1 = await readSseFrame(reader, decoder, buf);
    expect(frame1).not.toBeNull();
    expect(parseFrame(frame1!).event).toBe("text_delta");
    expect(JSON.parse(parseFrame(frame1!).data)).toEqual({ text: "first " });

    anthropicMock.emitText("second");
    const frame2 = await readSseFrame(reader, decoder, buf);
    expect(frame2).not.toBeNull();
    expect(parseFrame(frame2!).event).toBe("text_delta");
    expect(JSON.parse(parseFrame(frame2!).data)).toEqual({ text: "second" });

    anthropicMock.complete({
      content: [{ type: "text", text: "first second" }],
      stop_reason: "end_turn",
    });

    const finalFrame = await readSseFrame(reader, decoder, buf);
    expect(parseFrame(finalFrame!).event).toBe("message_complete");

    await reader.cancel();
  });

  it("delivers a burst of text_deltas to the wire without waiting for finalMessage", async () => {
    // This is the smoking-gun scenario from the bug report: the Anthropic SDK
    // parses an upstream HTTP chunk and synchronously emits multiple `text`
    // events in one tick. With fire-and-forget writeSSE the handler never
    // awaits between writes, so whether the bytes reach the socket before
    // cb(stream) resolves is down to node-server + Node's HTTP buffering.
    const anthropicMock = makeControllableStream();
    mockStream.mockReturnValue(anthropicMock);

    const res = await fetch(`http://127.0.0.1:${port}/llm/chat/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const buf = { value: "" };

    await new Promise((r) => setTimeout(r, 50));

    // Fire several deltas synchronously, simulating the SDK draining one
    // upstream chunk. Do NOT resolve finalMessage yet — we want to prove the
    // deltas are already on the wire before the overall turn completes.
    for (const tok of ["I", "'m", " ", "streaming", "!"]) {
      anthropicMock.emitText(tok);
    }

    const received: string[] = [];
    for (let i = 0; i < 5; i++) {
      const frame = await readSseFrame(reader, decoder, buf, 1000);
      if (frame === null) break;
      const parsed = parseFrame(frame);
      if (parsed.event !== "text_delta") break;
      received.push(JSON.parse(parsed.data).text);
    }

    // If the server is batching text_deltas until finalMessage resolves, we
    // read 0 frames here and this assertion fails — reproducing the user's
    // "thinking... then a blob appears" experience.
    expect(received).toEqual(["I", "'m", " ", "streaming", "!"]);

    anthropicMock.complete({
      content: [{ type: "text", text: "I'm streaming!" }],
      stop_reason: "end_turn",
    });

    await reader.cancel();
  });
});
