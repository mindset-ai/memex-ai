import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock all dependencies before importing the router
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      stream: vi.fn(),
    };
  }
  return { default: MockAnthropic };
});

// The routes now go through the lazy `getAnthropicClient()` wrapper instead of constructing
// the SDK at module load. Mock that wrapper here so the tests share the same mock instance
// without needing `ANTHROPIC_API_KEY` in the environment. `vi.hoisted` moves the fn above
// the vi.mock factory, which is itself hoisted.
const mockStream = vi.hoisted(() => vi.fn());
vi.mock("../agent/anthropic-client.js", () => ({
  getAnthropicClient: () => ({ messages: { stream: mockStream } }),
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
}));

vi.mock("../agent/context-builder.js", () => ({
  buildDocumentContext: vi.fn().mockResolvedValue({
    context: "Mock document context",
    phase: "plan",
  }),
  // spec-143 t-4 (dec-6): the drift-mode context builder.
  buildDriftContext: vi.fn().mockResolvedValue({
    context: "Open drift: 2 items across 1 standard.",
    phase: "plan",
  }),
}));

vi.mock("../agent/system-prompt.js", () => ({
  buildSystemBlocks: vi.fn().mockReturnValue([
    { type: "text", text: "instructions" },
    { type: "text", text: "context", cache_control: { type: "ephemeral" } },
  ]),
  buildCreationSystemBlocks: vi.fn().mockReturnValue([
    { type: "text", text: "creation instructions", cache_control: { type: "ephemeral" } },
  ]),
}));

vi.mock("../agent/tools.js", () => ({
  getToolDefinitions: vi.fn().mockReturnValue([
    { name: "update_section", description: "Update section", input_schema: { type: "object", properties: {} } },
  ]),
  getCreationToolDefinitions: vi.fn().mockReturnValue([
    { name: "create_doc", description: "Create doc", input_schema: { type: "object", properties: {} } },
  ]),
  executeServerTool: vi.fn(),
  isUiTool: vi.fn().mockReturnValue(false),
  isToolAllowedForReviewer: vi.fn().mockReturnValue(true),
  // spec-126 ac-15/ac-16: the readOnly write-gate predicate. Default false
  // (treat as a mutation) so a non-writer is blocked unless a test opts a tool in.
  isReadOnlyTool: vi.fn().mockReturnValue(false),
  // spec-143 t-4 (dec-6): the /tools/execute drift gate — permit only the drift
  // subset. Default true; individual tests override per tool name.
  isDriftModeTool: vi.fn().mockReturnValue(true),
}));

// spec-126: the /chat + /tools/execute routes resolve the viewer's per-doc role
// server-side via resolveRole. These spec-111 tests exercise the readOnly path,
// so default the role to `editor` (reviewer=false) — the review-overlay
// behaviour has its own dedicated suite (llm.review-overlay.test.ts).
vi.mock("../services/doc-members.js", () => ({
  resolveRole: vi.fn().mockResolvedValue("editor"),
}));

// spec-180: mock resolveIntegrationState so /chat tests don't need DB access.
// vi.hoisted so the value is available inside the hoisted vi.mock factory.
const mockIntegrationState = vi.hoisted(() => ({
  slackConnected: false,
  discordConnected: false,
  discordAmbiguous: false,
  discordChannelName: null,
}));
vi.mock("../agent/integration-state.js", () => ({
  resolveIntegrationState: vi.fn().mockResolvedValue(mockIntegrationState),
}));

vi.mock("../services/conversations.js", () => ({
  getOrCreateConversation: vi.fn().mockResolvedValue({ id: "conv-1" }),
  getMessages: vi.fn().mockResolvedValue([]),
  clearConversation: vi.fn().mockResolvedValue(undefined),
  // spec-156 ac-14: the save route now persists through the mutate()-wrapped
  // replaceMessages service rather than raw db.delete/db.insert.
  replaceMessages: vi.fn().mockResolvedValue(2),
}));

vi.mock("../db/connection.js", () => {
  const mockWhere = vi.fn().mockResolvedValue(undefined);
  const mockValues = vi.fn().mockResolvedValue(undefined);
  return {
    db: {
      delete: vi.fn().mockReturnValue({ where: mockWhere }),
      insert: vi.fn().mockReturnValue({ values: mockValues }),
    },
  };
});

vi.mock("../db/schema.js", () => ({
  messages: { conversationId: "conversationId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn().mockReturnValue("eq-condition"),
}));

vi.mock("../services/shared/sequence.js", () => ({
  nextSeq: vi.fn().mockResolvedValue(1),
}));

// spec-111 t-9: the /chat route derives the per-request readOnly flag from
// canWriteMemex against the resolved memex. Mock it so the default member case
// (write access) → readOnly=false, and a non-member case → readOnly=true.
vi.mock("../mcp/auth.js", () => ({
  canWriteMemex: vi.fn().mockResolvedValue(true),
  // spec-126 ac-15: the readOnly write-gate surfaces this canonical rejection
  // string (single-sourced in auth.js) — must be exported by the mock too.
  READ_ONLY_PUBLIC_MESSAGE: "Public Memexes are read-only for non-members",
}));

import { llmRouter } from "./llm.js";
import { canWriteMemex } from "../mcp/auth.js";
import { tagAc } from "@memex-ai-ac/vitest";
import { executeServerTool } from "../agent/tools.js";
import { buildDocumentContext, buildDriftContext } from "../agent/context-builder.js";
import { buildSystemBlocks, buildCreationSystemBlocks } from "../agent/system-prompt.js";
import { resolveIntegrationState } from "../agent/integration-state.js";
import { getCreationToolDefinitions, getToolDefinitions, isToolAllowedForReviewer, isReadOnlyTool, isDriftModeTool } from "../agent/tools.js";
import { resolveRole } from "../services/doc-members.js";
import { getOrCreateConversation, getMessages, clearConversation, replaceMessages } from "../services/conversations.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Build a test app with fake auth middleware. Post-t-13 /api/llm/* uses sessionMiddleware,
// which sets `user` (Memex User) and `currentAccount`. Stub those directly here.
function createTestApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user" as never, {
      id: "test-user-id",
      email: "test@example.com",
      status: "active",
    });
    c.set("currentAccount" as never, {
      id: "test-account-id",
      name: "Test",
      slug: "test",
      emailDomains: [],
      autoGroupingEnabled: false,
      domainVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    c.set("currentMemexId" as never, "test-account-id");
    c.set("currentRole" as never, "administrator");
    // spec-111 t-9: /chat reads currentUserId to derive the read-only flag.
    c.set("currentUserId" as never, "test-user-id");
    await next();
  });
  app.route("/llm", llmRouter);
  return app;
}

describe("POST /llm/tools/execute", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("executes a server tool and returns the result", async () => {
    vi.mocked(executeServerTool).mockResolvedValue("Section updated (abc).");

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "update_section",
        input: { sectionId: "abc", content: "New content" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe("Section updated (abc).");
    expect(executeServerTool).toHaveBeenCalledWith(
      "test-account-id",
      "update_section",
      { sectionId: "abc", content: "New content" },
      "test-user-id",
      undefined, // currentDocId — request body omits docId (b-34 T-12)
      "test@example.com", // spec-126 change-10: acting user's name (falls back to email)
    );
  });

  it("returns 400 for tool execution errors", async () => {
    vi.mocked(executeServerTool).mockRejectedValue(new Error("Unknown tool: bad_tool"));

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "bad_tool",
        input: {},
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Unknown tool: bad_tool");
  });

  it("validates request schema", async () => {
    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wrong: "shape" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
  });

  it("passes the user UUID (not email) for tool execution", async () => {
    // doc-14: services that write `createdByUserId` (createDocDraft, createStandard, …)
    // need the row UUID, not the email. The pre-doc-14 code passed `userEmail || userId`
    // which silently wrote the email into a UUID column.
    vi.mocked(executeServerTool).mockResolvedValue("done");

    await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "update_section", input: {} }),
    });

    expect(vi.mocked(executeServerTool).mock.calls[0][3]).toBe("test-user-id");
  });
});

describe("POST /llm/chat", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("validates request schema — rejects missing messages", async () => {
    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId: "not-a-uuid" }),
    });

    expect(res.status).toBe(400);
  });

  it("builds document context when docId is provided", async () => {
    const docId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    // Consume the SSE body so the stream callback completes
    await res.text();

    expect(buildDocumentContext).toHaveBeenCalledWith("test-account-id", docId);
    // b-33: buildSystemBlocks takes (context, phase). spec-111 t-9 adds a 3rd
    // `readOnly` arg — false here because the mocked canWriteMemex returns true
    // (the caller is a writing member). spec-126 adds a 4th `reviewer` arg —
    // false here because the mocked resolveRole returns "editor". Mock returns
    // { context: "Mock document context", phase: "plan" }.
    // spec-143 t-4 (dec-6) adds a 5th `driftMode` arg — false here (not drift).
    // spec-180 adds a 6th `integrationState` arg — the resolved integration status.
    expect(buildSystemBlocks).toHaveBeenCalledWith("Mock document context", "plan", false, false, false, mockIntegrationState);
  });

  it("uses fallback context when no docId", async () => {
    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Create a doc" }],
      }),
    });

    await res.text();

    expect(buildDocumentContext).not.toHaveBeenCalled();
    expect(buildSystemBlocks).toHaveBeenCalledWith(
      expect.stringContaining("No document loaded"),
      "plan",
      false,
      false,
      // spec-143 t-4 (dec-6): the 5th driftMode arg — false here (not drift).
      false,
      // spec-180: the 6th integrationState arg — the resolved integration status.
      mockIntegrationState,
    );
  });

  // spec-111 t-9 (ac-13): the read-only agent posture is driven by the
  // per-request readOnly flag the /chat route derives from canWriteMemex. A
  // signed-in NON-member on a public Memex (canWriteMemex → false) flips
  // readOnly to true; a member keeps it false (default member behaviour).
  it("passes readOnly=true to buildSystemBlocks for a non-member (ac-13)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-111/acs/ac-13");
    vi.mocked(canWriteMemex).mockResolvedValueOnce(false);
    const docId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId, messages: [{ role: "user", content: "Hi" }] }),
    });
    await res.text();

    expect(canWriteMemex).toHaveBeenCalledWith("test-user-id", "test-account-id");
    expect(buildSystemBlocks).toHaveBeenCalledWith("Mock document context", "plan", true, false, false, mockIntegrationState);
  });

  it("passes readOnly=false to buildSystemBlocks for a writing member (ac-13)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-111/acs/ac-13");
    vi.mocked(canWriteMemex).mockResolvedValueOnce(true);
    const docId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId, messages: [{ role: "user", content: "Hi" }] }),
    });
    await res.text();

    expect(buildSystemBlocks).toHaveBeenCalledWith("Mock document context", "plan", false, false, false, mockIntegrationState);
  });

  // spec-143 t-4 (dec-6): drift mode — the in-UI drift agent runs against the
  // Memex's open Standards drift with a drift-specific context, prompt, and the
  // focused drift tool subset, with NO bound doc.
  const AC_DRIFT_MODE =
    "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-12";

  it("uses buildDriftContext, the drift prompt, and the drift tool subset when mode='drift' (no docId)", async () => {
    tagAc(AC_DRIFT_MODE);
    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "drift",
        messages: [{ role: "user", content: "Show me the drift" }],
      }),
    });
    await res.text();

    // Drift context replaces the doc / creation branches entirely.
    expect(buildDriftContext).toHaveBeenCalledWith("test-account-id");
    expect(buildDocumentContext).not.toHaveBeenCalled();

    // The drift overlay is threaded into the prompt (5th driftMode arg = true)
    // and the tool surface is the focused drift subset (mode: 'drift').
    expect(buildSystemBlocks).toHaveBeenCalledWith(
      "Open drift: 2 items across 1 standard.",
      "plan",
      false,
      false,
      true,
      mockIntegrationState,
    );
    expect(getToolDefinitions).toHaveBeenCalledWith({ reviewer: false, mode: "drift" });
  });

  // spec-180 ac-3: integration state resolved server-side per request — not cached.
  it("ac-3: resolveIntegrationState is called on every /chat request with the current memexId and userId", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-180/acs/ac-3");
    const docId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId, messages: [{ role: "user", content: "Hello" }] }),
    });
    await res.text();

    expect(resolveIntegrationState).toHaveBeenCalledWith("test-account-id", "test-user-id");
  });
});

describe("POST /llm/tools/execute — drift mode (spec-143 t-4)", () => {
  let app: ReturnType<typeof createTestApp>;
  const AC_DRIFT_MODE =
    "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-12";

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("executes a drift-subset tool with NO docId (memex-scoped, role gate skipped)", async () => {
    tagAc(AC_DRIFT_MODE);
    vi.mocked(isDriftModeTool).mockReturnValue(true);
    vi.mocked(executeServerTool).mockResolvedValue("Drift flagged.");

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "flag_drift",
        input: { ref: "ns/mx/standards/std-1/sections/s-1", observation: "X drifted" },
        mode: "drift",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBe("Drift flagged.");
    // docId is null in drift mode → the doc-based role gate never runs.
    expect(resolveRole).not.toHaveBeenCalled();
  });

  it("rejects a non-drift tool in drift mode (403, fail closed)", async () => {
    tagAc(AC_DRIFT_MODE);
    vi.mocked(isDriftModeTool).mockReturnValue(false);

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "update_section",
        input: {},
        mode: "drift",
      }),
    });

    expect(res.status).toBe(403);
    expect(executeServerTool).not.toHaveBeenCalled();
  });
});

describe("GET /llm/conversations/:docId", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("returns stored messages", async () => {
    vi.mocked(getMessages).mockResolvedValue([
      { id: "m1", conversationId: "conv-1", role: "user", content: "Hello", seq: 1, createdAt: new Date() },
      { id: "m2", conversationId: "conv-1", role: "assistant", content: [{ type: "text", text: "Hi" }], seq: 2, createdAt: new Date() },
    ] as any);

    const res = await app.request("/llm/conversations/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
  });

  it("returns empty messages for new conversation", async () => {
    vi.mocked(getMessages).mockResolvedValue([]);

    const res = await app.request("/llm/conversations/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(0);
  });

  it("creates conversation for the authenticated user", async () => {
    vi.mocked(getMessages).mockResolvedValue([]);
    const docId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    await app.request(`/llm/conversations/${docId}`);

    expect(getOrCreateConversation).toHaveBeenCalledWith("test-account-id", docId, "test-user-id");
  });
});

describe("POST /llm/conversations/:docId/clear", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("clears conversation and returns ok", async () => {
    const docId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    const res = await app.request(`/llm/conversations/${docId}/clear`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(getOrCreateConversation).toHaveBeenCalledWith("test-account-id", docId, "test-user-id");
    expect(clearConversation).toHaveBeenCalledWith("conv-1");
  });
});

describe("POST /llm/conversations", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("validates request — requires docId and messages", async () => {
    const res = await app.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });

    expect(res.status).toBe(400);
  });

  it("saves messages and returns count", async () => {
    const docId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

    const res = await app.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.messageCount).toBe(2);
    expect(getOrCreateConversation).toHaveBeenCalledWith("test-account-id", docId, "test-user-id");
    // spec-156 ac-14: the route persists through the mutate()-wrapped service,
    // not raw db calls — it delegates the replace-all to replaceMessages,
    // threading the REST-surface channel so the emitted event carries
    // channel attribution instead of defaulting to channel:'server'.
    expect(replaceMessages).toHaveBeenCalledWith(
      "conv-1",
      [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ],
      { channel: "rest_ui" },
    );
  });
});

describe("POST /llm/chat/create", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("validates request schema — rejects missing messages", async () => {
    const res = await app.request("/llm/chat/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("uses creation system blocks and creation tools (not document context)", async () => {
    const res = await app.request("/llm/chat/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "I want to create a spec" }],
      }),
    });

    await res.text();

    // Creation-specific functions were called
    expect(buildCreationSystemBlocks).toHaveBeenCalled();
    expect(getCreationToolDefinitions).toHaveBeenCalled();

    // Document-context functions were NOT called
    expect(buildDocumentContext).not.toHaveBeenCalled();
    expect(buildSystemBlocks).not.toHaveBeenCalled();
  });

  it("does not require docId", async () => {
    const res = await app.request("/llm/chat/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Create a doc" }],
      }),
    });

    // Should not 400 — docId is not required
    expect(res.status).not.toBe(400);
  });

  it("strips dangling tool_use blocks before calling Anthropic (typed-past-widget regression)", async () => {
    // Repro from packages/server/.logs/agent.log: the agent emitted a
    // render_confirmation tool_use, SSE closed, and the user typed a fresh
    // message instead of clicking. Anthropic 400s without stripping.
    // The /chat/create route is the creation phase (no LangGraph resume),
    // so the dangling tool_use survives until we sanitise the history.
    const stream = {
      on: vi.fn().mockReturnThis(),
      finalMessage: vi
        .fn()
        .mockResolvedValue({ content: [], stop_reason: "end_turn" }),
    };
    mockStream.mockReturnValue(stream);

    const res = await app.request("/llm/chat/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "create a spec" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Confirm?" },
              {
                type: "tool_use",
                id: "toolu_01AEGrDhhgFBTcWkw4HHthY9",
                name: "render_confirmation",
                input: { message: "Looks good?" },
              },
            ],
          },
          { role: "user", content: "actually change the title" },
        ],
      }),
    });

    // Drain SSE so the handler runs to completion.
    await res.text();

    expect(res.status).toBe(200);
    expect(mockStream).toHaveBeenCalledTimes(1);
    // The dangling tool_use must not survive into the Anthropic call.
    const sentMessages = mockStream.mock.calls[0][0].messages;
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[1].content).toEqual([
      { type: "text", text: "Confirm?" },
    ]);
    // Trailing user message preserved verbatim.
    expect(sentMessages[2]).toEqual({
      role: "user",
      content: "actually change the title",
    });
  });
});

// ──────────────────────────────────────────────
// spec-126 — the review-mode overlay: server-derived role + execution gate.
// resolveRole is mocked here so the route wiring is exercised deterministically;
// the predicate's real fail-closed logic is covered in tools.review-allowance
// (ac-5), and the end-to-end path through the REAL resolveRole + a seeded
// doc_members row is covered in doc-members.review-overlay.integration (ac-4/ac-10).
// ──────────────────────────────────────────────
describe("spec-126 review overlay", () => {
  const AC126 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-126/acs/ac-${n}`;
  const REVIEW_DOC = "b7c1d2e3-f4a5-4b6c-8d9e-0f1a2b3c4d5e";
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it("/chat derives the role server-side via resolveRole and threads reviewer into the overlay (ac-3, ac-1)", async () => {
    tagAc(AC126(3));
    tagAc(AC126(1));
    vi.mocked(resolveRole).mockResolvedValueOnce("reviewer");
    const stream = {
      on: vi.fn().mockReturnThis(),
      finalMessage: vi.fn().mockResolvedValue({ content: [], stop_reason: "end_turn" }),
    };
    mockStream.mockReturnValue(stream);

    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A client-supplied `role` MUST be ignored — gating uses resolveRole only (ac-3).
      body: JSON.stringify({
        docId: REVIEW_DOC,
        role: "editor",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    await res.text();

    // ac-3: role derived server-side from (memexId, docId, userId).
    expect(resolveRole).toHaveBeenCalledWith("test-account-id", REVIEW_DOC, "test-user-id");
    // ac-1: the overlay threads reviewer into the server-built prompt + tool list.
    // spec-143 t-4 (dec-6): the 5th driftMode arg is false here; getToolDefinitions
    // now also receives `mode` (undefined when not in drift mode).
    expect(buildSystemBlocks).toHaveBeenCalledWith("Mock document context", "plan", false, true, false, mockIntegrationState);
    expect(getToolDefinitions).toHaveBeenCalledWith({ reviewer: true, mode: undefined });
  });

  it("/tools/execute rejects a blocked mutation for a reviewer at the gate — no execution (ac-6)", async () => {
    tagAc(AC126(6));
    vi.mocked(resolveRole).mockResolvedValueOnce("reviewer");
    vi.mocked(isToolAllowedForReviewer).mockReturnValueOnce(false); // resolve_decision is blocked (real logic: ac-5)

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "resolve_decision",
        input: { ref: "x", resolution: "y" },
        docId: REVIEW_DOC,
      }),
    });

    expect(res.status).toBe(403);
    expect(resolveRole).toHaveBeenCalledWith("test-account-id", REVIEW_DOC, "test-user-id");
    expect(executeServerTool).not.toHaveBeenCalled();
  });

  it("/tools/execute lets an allowed tool through for a reviewer (ac-7)", async () => {
    tagAc(AC126(7));
    vi.mocked(resolveRole).mockResolvedValueOnce("reviewer");
    vi.mocked(isToolAllowedForReviewer).mockReturnValueOnce(true); // add_comment allowed (real logic: ac-5)
    vi.mocked(executeServerTool).mockResolvedValue("Comment added.");

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "add_comment",
        input: { ref: "x", body: "nice" },
        docId: REVIEW_DOC,
      }),
    });

    expect(res.status).toBe(200);
    expect(executeServerTool).toHaveBeenCalled();
  });

  it("an editor passes the gate untouched (ac-2)", async () => {
    tagAc(AC126(2));
    vi.mocked(resolveRole).mockResolvedValueOnce("editor");
    vi.mocked(executeServerTool).mockResolvedValue("Section updated.");

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "update_section",
        input: { ref: "x", content: "z" },
        docId: REVIEW_DOC,
      }),
    });

    expect(res.status).toBe(200);
    expect(executeServerTool).toHaveBeenCalled();
  });

  // spec-126 ac-15 — the readOnly write-gate. A viewer who cannot write the Memex
  // (canWriteMemex → false: a signed-in non-member, who defaults to reviewer per
  // ac-4) is read-only EVERYWHERE: every mutating tool is rejected at the gate
  // before any execution, independent of role. Only readOnlyHint reads/search pass.
  it("/tools/execute rejects EVERY mutation for a non-writer — read-only everywhere (ac-15)", async () => {
    tagAc(AC126(15));
    vi.mocked(canWriteMemex).mockResolvedValueOnce(false); // non-member → cannot write
    vi.mocked(isReadOnlyTool).mockReturnValueOnce(false); // update_section mutates

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "update_section",
        input: { ref: "x", content: "z" },
        docId: REVIEW_DOC,
      }),
    });

    expect(res.status).toBe(403);
    expect(canWriteMemex).toHaveBeenCalledWith("test-user-id", "test-account-id");
    // Rejected by the write gate BEFORE the role gate and before any execution.
    expect(resolveRole).not.toHaveBeenCalled();
    expect(executeServerTool).not.toHaveBeenCalled();
  });

  it("/tools/execute still lets a non-writer run a read-only tool (ac-15)", async () => {
    tagAc(AC126(15));
    vi.mocked(canWriteMemex).mockResolvedValueOnce(false); // non-member
    vi.mocked(isReadOnlyTool).mockReturnValueOnce(true); // get_doc is read-only
    vi.mocked(executeServerTool).mockResolvedValue("Doc.");

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "get_doc",
        input: { ref: "x" },
        docId: REVIEW_DOC,
      }),
    });

    expect(res.status).toBe(200);
    expect(executeServerTool).toHaveBeenCalled();
  });

  // spec-126 ac-16 — the reviewer write allow-list applies only ON TOP of write
  // capability. A non-member who merely DEFAULTS to reviewer (canWrite=false) is
  // granted ZERO writes: each of the three allow-listed writes is rejected by the
  // readOnly gate, never reaching the role allow-list. The SAME calls succeed for
  // a writing member in reviewer posture (canWrite=true, allow-listed).
  it("/tools/execute blocks the reviewer write allow-list for a non-writer (ac-16)", async () => {
    tagAc(AC126(16));
    for (const toolName of ["add_comment", "update_comment", "register_issue"]) {
      vi.clearAllMocks();
      vi.mocked(canWriteMemex).mockResolvedValue(false); // non-member, defaults to reviewer
      vi.mocked(isReadOnlyTool).mockReturnValue(false); // these are mutations

      const res = await app.request("/llm/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName, input: { ref: "x" }, docId: REVIEW_DOC }),
      });

      expect(res.status, `${toolName} must be blocked for a non-writer`).toBe(403);
      expect(executeServerTool, `${toolName} must not execute`).not.toHaveBeenCalled();
    }
  });

  it("/tools/execute lets a WRITING reviewer use the allow-list (ac-16)", async () => {
    tagAc(AC126(16));
    vi.mocked(canWriteMemex).mockResolvedValueOnce(true); // org member in reviewer posture
    vi.mocked(resolveRole).mockResolvedValueOnce("reviewer");
    vi.mocked(isReadOnlyTool).mockReturnValueOnce(false); // add_comment mutates
    vi.mocked(isToolAllowedForReviewer).mockReturnValueOnce(true); // ...but is allow-listed
    vi.mocked(executeServerTool).mockResolvedValue("Comment added.");

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "add_comment",
        input: { ref: "x", body: "nice" },
        docId: REVIEW_DOC,
      }),
    });

    expect(res.status).toBe(200);
    expect(executeServerTool).toHaveBeenCalled();
  });

  it("no reviewAgent node or routeByPhaseAndMode router was added to the client graph (ac-1)", () => {
    tagAc(AC126(1));
    const graphPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../ui/src/agent/graph.ts",
    );
    const src = readFileSync(graphPath, "utf8");
    expect(src).not.toContain("reviewAgent");
    expect(src).not.toContain("routeByPhaseAndMode");
  });
});
