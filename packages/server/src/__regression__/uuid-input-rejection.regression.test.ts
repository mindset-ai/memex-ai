// b-36 T-7: regression gate for D-7 — every entity-acting MCP tool rejects
// raw UUID inputs at the boundary with the canonical "UUID inputs no longer
// accepted" error message.
//
// `mcp/refs.ts:assertRefNotUuid` (invoked by `resolveRefArg` in
// `agent/tool-specs.ts`) emits the verbatim phrase
//
//     UUID inputs no longer accepted; pass the ref.
//
// when a `ref` argument is a UUID. This regression suite asserts every
// ref-accepting catalogued tool surfaces that exact phrase when called with
// a UUID. Catches the regression where someone forgets to thread
// `assertRefNotUuid` through a new tool — the error would silently become
// "ref not found" instead, which is harder to diagnose.
//
// Skips: same justification as ref-emission.regression.test.ts. Tools that
// take `memex` (not `ref`) — `list_docs`, `create_doc`, `list_memexes` —
// don't have a `ref` field to attack with, so they're out of scope here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
  users,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { toolSpecs, type ToolCtx } from "../agent/tool-specs.js";

const FAKE_UUID = "00000000-0000-0000-0000-0000000000aa";

const cleanup = {
  memexes: [] as string[],
  docs: [] as string[],
  users: [] as string[],
};

afterAll(async () => {
  if (cleanup.memexes.length) {
    await db.delete(docComments).where(inArray(docComments.memexId, cleanup.memexes)).catch(() => {});
  }
  if (cleanup.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, cleanup.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, cleanup.docs)).catch(() => {});
    await db.delete(docSections).where(inArray(docSections.docId, cleanup.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, cleanup.docs)).catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
  for (const id of cleanup.users) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

// Tools that have no `ref` arg (memex-scoped or analysis-only). Skipped
// because they can't be probed for UUID rejection on the `ref` field.
const NO_REF_FIELD = new Set<string>([
  "list_docs",       // takes `memex` (slash form), not `ref`
  "create_doc",      // takes `memex` + `title` + `purpose`, not `ref`
  "list_memexes",    // no args; MCP-only
  "search_memex",    // T-8 owns this; takes `memex` + query, no `ref`
]);

// All shared tool specs that take a `ref` arg — derived dynamically from the
// catalogue so additions are automatically caught.
function refAcceptingTools(): string[] {
  return toolSpecs
    .filter((s) => Object.prototype.hasOwnProperty.call(s.schema, "ref"))
    .filter((s) => !NO_REF_FIELD.has(s.name))
    .map((s) => s.name);
}

describe("regression: every ref-accepting MCP tool rejects a UUID input with the canonical hard-error (b-36 D-7)", () => {
  let memexId: string;
  let userId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("uuid-reject");
    cleanup.memexes.push(memexId);
    const [u] = await db
      .insert(users)
      .values({
        email: `uuid-reject-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai`,
      } as never)
      .returning();
    cleanup.users.push(u.id);
    userId = u.id;
  });

  function ctxForUuidProbe(): ToolCtx {
    // The boundary guard fires before any DB work. We supply a real-shape ctx
    // anyway so the spec doesn't crash on missing methods if some shared spec
    // touches ctx before validation (defensive).
    return {
      userId,
      resolveMemexFromEntity: async () => memexId,
      resolveMemex: async () => memexId,
      resolveRef: async () => {
        // Should never be reached — the UUID guard should reject first.
        throw new Error("resolveRef called: ref guard didn't fire?");
      },
      workspaceUrl: async () => "",
      verbose: false,
    };
  }

  it("every ref-accepting catalogued tool rejects a UUID at the boundary with the canonical message", async () => {
    const tools = refAcceptingTools();
    expect(tools.length, "regression suite found no ref-accepting tools; catalogue is empty?").toBeGreaterThan(0);
    const failures: string[] = [];
    for (const name of tools) {
      const spec = toolSpecs.find((s) => s.name === name);
      if (!spec) {
        failures.push(`${name}: spec not registered`);
        continue;
      }
      try {
        // Supply only `ref: <uuid>` plus minimum-shape required fields. The
        // ref guard fires first regardless of the other args, so passing
        // dummy strings is safe.
        const input = buildMinimalInput(name);
        await spec.handler(input, ctxForUuidProbe());
        failures.push(`${name}: accepted a UUID without throwing — the boundary guard isn't wired in.`);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!msg.includes("UUID inputs no longer accepted")) {
          failures.push(`${name}: threw, but not the canonical message — got: "${msg}"`);
        }
      }
    }
    expect(failures, failures.length === 0 ? "" : failures.join("\n")).toEqual([]);
  });
});

// Build minimum-shape input for a tool — only fields that must be present for
// the handler to reach the ref guard. The guard fires before any other
// validation, so we can keep these stubs lean.
function buildMinimalInput(name: string): Record<string, unknown> {
  const base: Record<string, unknown> = { ref: FAKE_UUID };
  // Required-field stubs for tools whose schema validates structure before
  // reaching the handler body. zod processes the whole schema regardless of
  // order, so missing required fields would yield a zod error before the
  // ref guard fires.
  switch (name) {
    case "update_doc":
      base.title = "x";
      break;
    case "add_section":
      base.sectionType = "x";
      base.content = "x";
      break;
    case "update_section":
      base.content = "x";
      break;
    case "create_decision":
      base.title = "x";
      break;
    case "update_decision":
      base.status = "open";
      break;
    case "resolve_decision":
      base.resolution = "x";
      break;
    case "reject_candidate":
      base.reason = "x";
      break;
    case "create_task":
      base.title = "x";
      base.description = "x";
      break;
    case "update_task":
      // At least one mutating field — status keeps the spec happy.
      base.status = "in_progress";
      break;
    case "add_comment":
      base.authorName = "x";
      base.content = "x";
      break;
    case "list_comments":
      // no extra required fields
      break;
    case "update_comment":
      base.status = "resolved";
      break;
    case "assess_spec":
      base.mode = "phase";
      base.target = "build";
      break;
    case "publish_spec":
      // no extra required fields
      break;
  }
  return base;
}
