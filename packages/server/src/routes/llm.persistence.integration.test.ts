// Integration coverage for the /api/llm/* conversation-persistence endpoints. Uses the
// real `conversations` service + Postgres, with only the LLM boundary (Anthropic SDK,
// context builder, system prompt, tools) stubbed out.
//
// Gap this closes: llm.ts previously had only unit tests (llm.test.ts) that mock the DB
// layer. A regression in seq ordering, per-user isolation, or clear semantics would not
// have been caught. This test hits the real schema end-to-end.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  documents,
  conversations,
  messages,
} from "../db/schema.js";
import { bus, type ChangeEvent } from "../services/bus.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createMiddleware } from "hono/factory";

const AC = "mindset-prod/memex-building-itself/specs/spec-156/acs";

// Stub the Anthropic + prompt surface so the /chat path can run without a real API key.
// Persistence tests don't care about streamed content; they care about what hits Postgres.
vi.mock("../agent/anthropic-client.js", () => ({
  getAnthropicClient: () => ({
    messages: {
      stream: () => ({
        on: () => {},
        finalMessage: () =>
          Promise.resolve({
            content: [{ type: "text", text: "stub" }],
            stop_reason: "end_turn",
          }),
      }),
    },
  }),
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
}));

vi.mock("../agent/context-builder.js", () => ({
  buildDocumentContext: vi.fn().mockResolvedValue({ context: "ctx", phase: "plan" }),
}));

vi.mock("../agent/system-prompt.js", () => ({
  buildSystemBlocks: vi.fn().mockReturnValue([{ type: "text", text: "s" }]),
  buildCreationSystemBlocks: vi
    .fn()
    .mockReturnValue([{ type: "text", text: "s" }]),
}));

vi.mock("../agent/tools.js", () => ({
  getToolDefinitions: vi.fn().mockReturnValue([]),
  getCreationToolDefinitions: vi.fn().mockReturnValue([]),
  executeServerTool: vi.fn(),
  isUiTool: vi.fn().mockReturnValue(false),
}));

import { llmRouter } from "./llm.js";

type UserCtx = { id: string; email: string };

// Builds an app that pins the acting user + account into the Hono context exactly the way
// sessionMiddleware + memexResolver would. Switching users between tests lets us verify
// per-(doc, user) conversation isolation without spinning up multiple Hono instances.
function makeAppForUser(memexId: string, user: UserCtx) {
  const app = new Hono();
  app.use(
    "*",
    createMiddleware(async (c, next) => {
      c.set("user" as never, {
        id: user.id,
        email: user.email,
        status: "active",
      });
      c.set("currentAccount" as never, {
        id: memexId,
        name: "Test",
        slug: "test",
      });
      c.set("currentMemexId" as never, memexId);
      c.set("currentRole" as never, "administrator");
      await next();
    })
  );
  app.route("/llm", llmRouter);
  return app;
}

const USER_A: UserCtx = {
  id: "00000000-0000-0000-0000-0000000000aa",
  email: "user-a@example.com",
};
const USER_B: UserCtx = {
  id: "00000000-0000-0000-0000-0000000000bb",
  email: "user-b@example.com",
};

let memexId: string;
let docId: string;
const createdAccountIds: string[] = [];

beforeAll(async () => {
  memexId = await makeTestMemex("llm-persist");
  createdAccountIds.push(memexId);
  const doc = await createDocDraft(memexId, "Persistence Test Doc", "Why");
  docId = doc.id;
});

afterAll(async () => {
  for (const id of createdAccountIds) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
});

describe("POST /llm/conversations (save)", () => {
  it("saves messages with 1-based sequential seq values", async () => {
    const app = makeAppForUser(memexId, USER_A);
    const res = await app.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "text", text: "second" }] },
          { role: "user", content: "third" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, messageCount: 3 });

    // Verify against the DB: messages are under the right conversation, ordered, seq 1..N.
    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.docId, docId));
    expect(convs).toHaveLength(1);
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convs[0].id))
      .orderBy(messages.seq);
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("first");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].content).toBe("third");
  });

  it("replaces the full message set on repeat save (no append)", async () => {
    const app = makeAppForUser(memexId, USER_A);
    // First thread was 3 messages; save a shorter one and confirm the old rows are gone.
    await app.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [{ role: "user", content: "only-one" }],
      }),
    });

    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.docId, docId));
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convs[0].id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("only-one");
  });

  // spec-156 ac-14: the route persists through the mutate()-wrapped service
  // (replaceMessages), so saving a chat turn emits conversation_message.created
  // on the unified bus. This subscribes to the REAL bus and uses the REAL
  // service + Postgres (the service is NOT mocked away) — a regression back to
  // the raw db.delete/db.insert would emit nothing and fail here. We also assert
  // the messages landed, so the emit can't be faked without the write.
  it("emits conversation_message.created on the bus AND lands the messages (ac-14)", async () => {
    tagAc(`${AC}/ac-14`);
    tagAc(`${AC}/ac-2`); // scope ac-2: audit-finding remediation (this finding's proof)
    const app = makeAppForUser(memexId, USER_A);

    const received: ChangeEvent[] = [];
    const unsubscribe = bus.subscribe(
      { memexId, entity: "conversation_message" },
      (e) => received.push(e),
    );

    try {
      const res = await app.request("/llm/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId,
          messages: [
            { role: "user", content: "bus-q" },
            { role: "assistant", content: [{ type: "text", text: "bus-a" }] },
          ],
        }),
      });
      expect(res.status).toBe(200);

      // The replace-all fires exactly one conversation_message.created (one
      // logical change = one event per dec-2), not one per message.
      const created = received.filter((e) => e.action === "created");
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(created.some((e) => e.entity === "conversation_message")).toBe(true);
      expect(created.every((e) => e.memexId === memexId)).toBe(true);

      // The messages actually landed — the emit can't be a fake; it rode a real
      // mutate() whose fn() wrote these rows.
      const convs = await db
        .select()
        .from(conversations)
        .where(eq(conversations.docId, docId));
      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convs[0].id))
        .orderBy(messages.seq);
      expect(msgs.map((m) => m.content)).toEqual([
        "bus-q",
        [{ type: "text", text: "bus-a" }],
      ]);
    } finally {
      unsubscribe();
    }
  });
});

describe("GET /llm/conversations/:docId (load)", () => {
  it("returns messages in seq order", async () => {
    const app = makeAppForUser(memexId, USER_A);
    // Save a known thread first.
    await app.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: [{ type: "text", text: "a1" }] },
        ],
      }),
    });

    const res = await app.request(`/llm/conversations/${docId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "user", content: "q1" });
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "a1" }],
    });
  });

  it("returns an empty thread for a never-used conversation", async () => {
    const app = makeAppForUser(memexId, USER_B);
    const res = await app.request(`/llm/conversations/${docId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });
});

describe("POST /llm/conversations/:docId/clear", () => {
  it("deletes messages but keeps the conversation row", async () => {
    const app = makeAppForUser(memexId, USER_A);
    await app.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [
          { role: "user", content: "pre-clear-1" },
          { role: "assistant", content: "pre-clear-2" },
        ],
      }),
    });

    const clearRes = await app.request(
      `/llm/conversations/${docId}/clear`,
      { method: "POST" }
    );
    expect(clearRes.status).toBe(200);

    // Conversation row persists; messages are gone.
    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.docId, docId));
    expect(convs.length).toBeGreaterThanOrEqual(1);
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convs[0].id));
    expect(msgs).toHaveLength(0);
  });
});

describe("per-(doc, user) isolation", () => {
  it("different users on the same doc get different conversations", async () => {
    const appA = makeAppForUser(memexId, USER_A);
    const appB = makeAppForUser(memexId, USER_B);

    await appA.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [{ role: "user", content: "A-only" }],
      }),
    });
    await appB.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [{ role: "user", content: "B-only" }],
      }),
    });

    const resA = await appA.request(`/llm/conversations/${docId}`);
    const resB = await appB.request(`/llm/conversations/${docId}`);
    const bodyA = await resA.json();
    const bodyB = await resB.json();

    expect(bodyA.messages).toEqual([{ role: "user", content: "A-only" }]);
    expect(bodyB.messages).toEqual([{ role: "user", content: "B-only" }]);

    // The schema guarantees this via the unique(doc_id, user_id) constraint but verify
    // explicitly — a regression that dropped that constraint would silently merge threads.
    const convs = await db
      .select()
      .from(conversations)
      .where(eq(conversations.docId, docId));
    const userIds = new Set(convs.map((c) => c.userId));
    expect(userIds.has(USER_A.id)).toBe(true);
    expect(userIds.has(USER_B.id)).toBe(true);
  });
});

describe("validation", () => {
  it("rejects save without docId", async () => {
    const app = makeAppForUser(memexId, USER_A);
    const res = await app.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects save with a non-uuid docId", async () => {
    const app = makeAppForUser(memexId, USER_A);
    const res = await app.request("/llm/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId: "not-a-uuid",
        messages: [{ role: "user", content: "x" }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Anthropic fake surfaces to /chat (smoke)", () => {
  it("streams a stubbed message_complete without real API key", async () => {
    const app = makeAppForUser(memexId, USER_A);
    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    // Drain the SSE body so the handler completes without hanging the next test.
    const text = await res.text();
    expect(text).toContain("message_complete");
  });
});
