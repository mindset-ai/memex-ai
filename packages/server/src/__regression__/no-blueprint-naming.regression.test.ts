import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db/connection.js";
import { DOC_TYPES, COMMENT_REFERENCE_TYPES } from "../types/roles.js";

// Per t-4 of doc-8 (Blueprints → Standards rename): once Phase 1 lands, the literal
// string `blueprint` must NOT appear in any of the surfaces that an agent or human
// can observe at runtime — the docType enum, the cross-reference enum, the live DB
// CHECK constraint that gates `doc_comments.reference_type`, or the names of the
// agent/MCP tools the agent calls.
//
// Failures here usually mean a partial revert — someone reintroduced a `'blueprint'`
// literal somewhere (or skipped applying migration 0030). The test does NOT scan
// arbitrary source comments — historical docstrings and migration files legitimately
// mention "blueprint" — only the active runtime surfaces.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(__dirname, "..");
const AGENT_TOOLS_PATH = resolve(SERVER_SRC, "agent/tools.ts");
const MCP_TOOLS_PATH = resolve(SERVER_SRC, "mcp/tools.ts");

describe("regression: no 'blueprint' in production surfaces", () => {
  it("DOC_TYPES enum no longer contains 'blueprint'", () => {
    expect(DOC_TYPES).not.toContain("blueprint");
    expect(DOC_TYPES).toContain("standard");
  });

  it("COMMENT_REFERENCE_TYPES no longer contains 'blueprint'", () => {
    expect(COMMENT_REFERENCE_TYPES).not.toContain("blueprint");
    expect(COMMENT_REFERENCE_TYPES).toContain("standard");
  });

  // doc-26 t-4: the doc_comments_reference_type_valid CHECK constraint was
  // dropped (migration 0046) when the legacy (reference_type, reference_id)
  // text pair was replaced by four structured FK columns. The blueprint guard
  // is now enforced by the application layer + the new XOR CHECK
  // (doc_comments_cross_reference_target) on the reference_* FK columns —
  // there is no longer a string-typed list of reference types in the schema.
  it("legacy doc_comments_reference_type_valid CHECK constraint is gone (replaced by structured FKs)", async () => {
    const rows = await db.execute(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'doc_comments_reference_type_valid'`
    );
    // After migration 0046 the named CHECK constraint should no longer exist.
    expect((rows as unknown as Array<{ def: string }>).length).toBe(0);
  });

  it("agent/tools.ts defines no tool whose `name` field contains 'blueprint'", () => {
    const src = readFileSync(AGENT_TOOLS_PATH, "utf8");
    // `name: "<word>"` is the schema shape every entry in the agent tools list uses.
    const names = Array.from(src.matchAll(/^\s*name:\s*"([^"]+)"/gm)).map((m) => m[1]);
    const offenders = names.filter((n) => n.toLowerCase().includes("blueprint"));
    expect(offenders, `agent tool names containing 'blueprint': ${offenders.join(", ")}`).toEqual([]);
  });

  it("mcp/tools.ts registers no MCP tool whose first-arg string contains 'blueprint'", () => {
    const src = readFileSync(MCP_TOOLS_PATH, "utf8");
    // Tool registrations look like `server.tool("<name>", "description", ...)`.
    // The first quoted string after `server.tool(` is the tool name.
    const names = Array.from(src.matchAll(/server\.tool\(\s*"([^"]+)"/g)).map((m) => m[1]);
    const offenders = names.filter((n) => n.toLowerCase().includes("blueprint"));
    expect(offenders, `MCP tool names containing 'blueprint': ${offenders.join(", ")}`).toEqual([]);
  });
});
