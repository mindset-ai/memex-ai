// t-9 of doc-14: parameterised assertion that every cut tool name in
// migration-map.ts produces a structured migration error.
//
// Two layers of assertion:
//
//   1. Pure: `migrationErrorMessage(oldName)` returns a string referencing both
//      the old name and the replacement. This is the core contract every cut
//      tool must satisfy.
//
//   2. End-to-end through the HTTP MCP endpoint: invoke the JSON-RPC `tools/call`
//      method with a representative cut tool name (`update_task_status`) and
//      assert the response is the structured error from the migration map. Just
//      one entry — once the dispatch path is proven, layer 1 covers the
//      breadth.
//
// No DB calls — this suite is "integration" only in the sense that it goes
// through the Hono request handler.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../app.js";
import { db } from "../db/connection.js";
import { users, mcpTokens } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import {
  MIGRATION_MAP,
  REMOVED_TOOL_NAMES,
  migrationErrorMessage,
  ARG_MIGRATIONS,
  argMigrationErrorMessage,
} from "./migration-map.js";

describe("migration-map.ts — pure migrationErrorMessage()", () => {
  it.each(REMOVED_TOOL_NAMES)("%s emits a structured error referencing both old and new names", (oldName) => {
    const msg = migrationErrorMessage(oldName);
    expect(msg).toBeTruthy();
    // Must mention the old name (verbatim, in backticks per the format).
    expect(msg).toContain(`\`${oldName}\``);
    // Must mention the replacement.
    const entry = MIGRATION_MAP[oldName];
    expect(msg).toContain(entry.replacement);
    // Must mention the doc-14 / refactor framing so an LLM knows it's not a
    // transient error but a contract change.
    expect(msg).toMatch(/doc-14|refactor/);
  });

  it("returns null for unknown tool names (no false positives)", () => {
    expect(migrationErrorMessage("get_doc")).toBeNull();
    expect(migrationErrorMessage("create_task")).toBeNull();
    expect(migrationErrorMessage("totally_made_up")).toBeNull();
  });

  it("every entry has a non-empty note", () => {
    for (const name of REMOVED_TOOL_NAMES) {
      expect(MIGRATION_MAP[name].note).toBeTruthy();
      expect(MIGRATION_MAP[name].note.length).toBeGreaterThan(0);
    }
  });
});

// b-42 t-4 — argument-name migration. Pre-fix, a stale client passing
// {docId: "..."} (or taskId / sectionId / etc.) got a raw Zod error like
// "expected string, received undefined" on the `ref` field with no migration
// path. Now we detect known-old field names and return a structured hint
// pointing at the b-36 canonical-ref form.
describe("migration-map.ts — pure argMigrationErrorMessage() (b-42 t-4)", () => {
  it("returns null for args with no old field names", () => {
    expect(argMigrationErrorMessage({})).toBeNull();
    expect(argMigrationErrorMessage({ ref: "foo/bar/specs/spec-1" })).toBeNull();
    expect(argMigrationErrorMessage({ title: "Hello" })).toBeNull();
  });

  it("returns a hint when an old field name appears", () => {
    const msg = argMigrationErrorMessage({ docId: "uuid" });
    expect(msg).toBeTruthy();
    expect(msg).toContain("docId");
    expect(msg).toContain("ref");
    expect(msg).toMatch(/b-36|canonical/);
  });

  it("lists every old field name when multiple appear", () => {
    const msg = argMigrationErrorMessage({ docId: "x", taskId: "y" });
    expect(msg).toBeTruthy();
    expect(msg).toContain("docId");
    expect(msg).toContain("taskId");
  });

  it("fires even when both old and new args are passed (caller mixing shapes)", () => {
    const msg = argMigrationErrorMessage({ ref: "a/b/c", docId: "uuid" });
    expect(msg).toBeTruthy();
    expect(msg).toContain("docId");
  });

  it("every ARG_MIGRATIONS entry has a non-empty note", () => {
    for (const [name, note] of Object.entries(ARG_MIGRATIONS)) {
      expect(note).toBeTruthy();
      expect(note.length).toBeGreaterThan(0);
      // Each note should at minimum point at `ref` as the replacement field.
      expect(note).toContain("ref");
    }
  });
});

// ── HTTP-level path through app.ts ─────────────────────────────────────
// One sample call confirms the migration intercept actually fires inside the
// MCP route. Uses a freshly minted token; cleans up after.

const created = { tokens: [] as string[], users: [] as string[] };

async function mintTestToken(): Promise<{ raw: string; userId: string }> {
  const sub = `mig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as any).returning();
  created.users.push(u.id);
  const raw = `mxt_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const [tok] = await db
    .insert(mcpTokens)
    .values({
      userId: u.id,
      label: "migration-errors-test",
      tokenHash,
      prefix: raw.slice(0, 12),
    } as any)
    .returning();
  created.tokens.push(tok.id);
  return { raw, userId: u.id };
}

afterAll(async () => {
  for (const id of created.tokens) await db.delete(mcpTokens).where(eq(mcpTokens.id, id)).catch(() => {});
  for (const id of created.users) await db.delete(users).where(eq(users.id, id)).catch(() => {});
});

describe("MCP HTTP endpoint — migration intercept", () => {
  let token: { raw: string; userId: string };

  beforeAll(async () => {
    token = await mintTestToken();
  });

  it("calling a removed tool name through the HTTP MCP route returns the migration error", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.raw}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "update_task_status", arguments: { taskId: "x", status: "complete" } },
      }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { isError: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(42);
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(text).toContain("update_task_status");
    expect(text).toContain("update_task");
  });

  // b-42 t-4 — argument-name migration intercept at the HTTP endpoint.
  it("calling a current tool with an old arg name returns the structured arg migration hint", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.raw}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 43,
        method: "tools/call",
        // get_doc is a current tool; docId is the b-36-removed arg name.
        params: { name: "get_doc", arguments: { docId: "some-uuid" } },
      }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { isError: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(body.id).toBe(43);
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(text).toContain("docId");
    expect(text).toContain("ref");
    expect(text).toMatch(/b-36|canonical/);
  });
});
