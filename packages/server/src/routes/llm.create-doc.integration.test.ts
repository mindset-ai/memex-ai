// Regression for the UUID-vs-email bug fixed in doc-2 t-1.
//
// History: pre-doc-14 the chat-driven `create_doc` flow shipped with
// `routes/llm.ts` passing `userEmail || userId` into `executeServerTool`.
// `createDocDraft` writes that value into `documents.created_by_user_id`,
// a UUID column — so any chat-driven create_doc failed at insert time with
// `invalid input syntax for type uuid: "<email>"`. The fix passes `user.id`
// (the UUID) directly. This test pins that contract end-to-end so it can't
// regress silently.
//
// What we assert:
//   1. POST /llm/tools/execute with `create_doc` succeeds.
//   2. The created document's `created_by_user_id` column equals the
//      authenticated user's UUID — provably a UUID, not an email.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { db } from "../db/connection.js";
import { memexes, documents, users } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { llmRouter } from "./llm.js";

// spec-126 ac-15/ac-16: the in-app /tools/execute write gate now calls
// canWriteMemex. This round-trip test acts as an authorized writer (the gate
// itself is unit-tested in llm.test.ts), so grant write capability — otherwise
// the org-namespace test user (no membership) is correctly read-only.
vi.mock("../mcp/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/auth.js")>()),
  canWriteMemex: vi.fn().mockResolvedValue(true),
}));

let memexId: string;
let userId: string;
const cleanupAccounts: string[] = [];
const cleanupUsers: string[] = [];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeApp() {
  const app = new Hono();
  app.use(
    "*",
    createMiddleware(async (c, next) => {
      c.set("user" as never, {
        id: userId,
        email: "uuid-regression-test@memex.ai",
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
    }),
  );
  app.route("/llm", llmRouter);
  return app;
}

beforeAll(async () => {
  memexId = await makeTestMemex("uuid-regress");
  cleanupAccounts.push(memexId);
  const [u] = await db
    .insert(users)
    .values({ email: `uuid-regress-${Date.now()}@memex.ai` } as any)
    .returning();
  userId = u.id;
  cleanupUsers.push(u.id);
});

afterAll(async () => {
  for (const id of cleanupAccounts) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
  for (const id of cleanupUsers) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

describe("regression: chat-driven create_doc writes a UUID into created_by_user_id (doc-2 t-1)", () => {
  it("create_doc via /llm/tools/execute persists user.id (UUID), not email", async () => {
    const app = makeApp();

    // Sanity: the test fixture is actually a UUID and not an email.
    expect(userId).toMatch(UUID_REGEX);

    const res = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "create_doc",
        input: {
          title: "UUID regression doc",
          purpose:
            "Confirms `documents.created_by_user_id` receives the user UUID, " +
            "not the email. Ships as a regression test for the chat-create flow.",
          docType: "spec",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string };
    expect(body.result).toMatch(/Spec created/i);

    // Pull the row directly — the bug would have happened at insert time, but
    // we assert the column value too so a future migration can't accidentally
    // backfill the wrong field.
    const row = await db.query.documents.findFirst({
      where: eq(documents.title, "UUID regression doc"),
      columns: { id: true, memexId: true, createdByUserId: true },
    });
    expect(row).toBeDefined();
    expect(row!.memexId).toBe(memexId);
    expect(row!.createdByUserId).toBe(userId);
    // The crux: the column holds a UUID, not an email or any other shape.
    expect(row!.createdByUserId).toMatch(UUID_REGEX);
    expect(row!.createdByUserId).not.toContain("@");
  });
});
