// b-36 T-4 — redirect-layer integration tests.
//
// Covers the spec from b-36 D-6:
//   1. Direct redirect: exact match returns the new path.
//   2. Prefix match — child path (.../tasks/t-1) inherits the parent's redirect.
//   3. Prefix match — section path (.../sections/s-2) inherits too.
//   4. Transitive chain: A→B + B→C resolves A to C in one call.
//   5. Cycle guard: A→B + B→A throws (rather than looping forever).
//   6. Not-found: an unmatched path returns {notFound: true}.
//   7. insertRedirect validates inputs via parseRef and rejects malformed refs.
//   8. insertRedirect is idempotent — re-inserting the same old_path updates
//      the row instead of erroring on the PK conflict.
//
// Tests scope themselves with unique namespace + memex slugs so they don't
// collide with each other or pollute the global redirects table; cleanup
// deletes their own rows.

import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { lookupRedirect, insertRedirect, rewriteBriefPathToSpec } from "./redirects.js";

// Each test owns a unique namespace + memex prefix to keep its inserted
// redirects isolated from sibling tests in parallel runs (sequential here,
// but cheap insurance). After each test, drop every row that starts with
// its prefix so the global redirects table stays clean.
function uniquePrefix(label: string): string {
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `t4-${label}-${tail}`.toLowerCase();
}

const cleanupPrefixes: string[] = [];

afterEach(async () => {
  while (cleanupPrefixes.length) {
    const prefix = cleanupPrefixes.pop()!;
    // Wipe any redirect whose old_path or new_path touches this test's namespace.
    await db.execute(sql`
      DELETE FROM redirects
       WHERE old_path LIKE ${prefix + "%"}
          OR new_path LIKE ${prefix + "%"}
    `);
  }
});

// Build canonical paths under the given namespace prefix. The ref grammar
// requires `<ns>/<mx>/<doc-type>/<handle>` so we always produce a 4- or
// 6-segment path that parseRef accepts. b-105: the Spec docType (formerly
// Brief) now lives under `/specs/spec-N` per dec-3 + dec-6.
function pathFor(prefix: string, memex: string, doc = "spec-12", child?: string) {
  const base = `${prefix}/${memex}/specs/${doc}`;
  return child ? `${base}/${child}` : base;
}

describe("redirects service (b-36 T-4)", () => {
  it("direct redirect: exact match returns the new path", async () => {
    const prefix = uniquePrefix("direct");
    cleanupPrefixes.push(prefix);

    const oldPath = pathFor(prefix, "personal");
    const newPath = pathFor(prefix, "team");
    await insertRedirect(oldPath, newPath, "brief_move");

    const result = await lookupRedirect(oldPath);
    expect(result).toEqual({ redirected: newPath });
  });

  it("prefix match: child task path inherits the parent redirect", async () => {
    const prefix = uniquePrefix("child-task");
    cleanupPrefixes.push(prefix);

    const oldParent = pathFor(prefix, "personal");
    const newParent = pathFor(prefix, "team");
    await insertRedirect(oldParent, newParent, "brief_move");

    const oldChild = pathFor(prefix, "personal", "spec-12", "tasks/t-1");
    const expected = pathFor(prefix, "team", "spec-12", "tasks/t-1");
    const result = await lookupRedirect(oldChild);
    expect(result).toEqual({ redirected: expected });
  });

  it("prefix match: section path inherits the parent redirect", async () => {
    const prefix = uniquePrefix("child-section");
    cleanupPrefixes.push(prefix);

    const oldParent = pathFor(prefix, "personal");
    const newParent = pathFor(prefix, "team");
    await insertRedirect(oldParent, newParent, "brief_move");

    const oldChild = pathFor(prefix, "personal", "spec-12", "sections/s-2");
    const expected = pathFor(prefix, "team", "spec-12", "sections/s-2");
    const result = await lookupRedirect(oldChild);
    expect(result).toEqual({ redirected: expected });
  });

  it("transitive chain: A→B + B→C resolves A to C", async () => {
    const prefix = uniquePrefix("chain");
    cleanupPrefixes.push(prefix);

    const a = pathFor(prefix, "a-ns");
    const b = pathFor(prefix, "b-ns");
    const c = pathFor(prefix, "c-ns");
    await insertRedirect(a, b, "brief_move");
    await insertRedirect(b, c, "brief_move");

    const result = await lookupRedirect(a);
    expect(result).toEqual({ redirected: c });
  });

  it("cycle guard: A→B + B→A throws", async () => {
    const prefix = uniquePrefix("cycle");
    cleanupPrefixes.push(prefix);

    const a = pathFor(prefix, "left");
    const b = pathFor(prefix, "right");
    await insertRedirect(a, b, "brief_move");
    await insertRedirect(b, a, "brief_move");

    await expect(lookupRedirect(a)).rejects.toThrow(/cycle|maxDepth/i);
  });

  it("not-found: no matching row returns {notFound: true}", async () => {
    const prefix = uniquePrefix("404");
    cleanupPrefixes.push(prefix);

    // Don't insert anything — just look up a path under our prefix.
    const result = await lookupRedirect(pathFor(prefix, "ghost", "spec-9999"));
    expect(result).toEqual({ notFound: true });
  });

  it("insertRedirect rejects malformed paths", async () => {
    // No prefix to clean — these should throw before any DB row is written.
    await expect(insertRedirect("b36", "mindset/team/specs/spec-12", "brief_move")).rejects.toThrow();
    await expect(insertRedirect("mindset/team/specs/spec-12", "Spec-12", "brief_move")).rejects.toThrow();
  });

  it("re-insert is idempotent: second call updates the row without erroring", async () => {
    const prefix = uniquePrefix("idem");
    cleanupPrefixes.push(prefix);

    const oldPath = pathFor(prefix, "personal");
    const target1 = pathFor(prefix, "team");
    const target2 = pathFor(prefix, "other");

    await insertRedirect(oldPath, target1, "brief_move");
    // Second call uses a different reason + new target — should UPSERT.
    await insertRedirect(oldPath, target2, "memex_rename");

    const result = await lookupRedirect(oldPath);
    expect(result).toEqual({ redirected: target2 });

    // Confirm there's exactly one row in DB for this old_path.
    const rows = (await db.execute(sql`
      SELECT old_path, new_path, reason FROM redirects WHERE old_path = ${oldPath}
    `)) as unknown as Array<{ old_path: string; new_path: string; reason: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].new_path).toBe(target2);
    expect(rows[0].reason).toBe("memex_rename");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// b-105 — code-level /briefs/b-N → /specs/spec-N permanent path rewrite.
// Pure (no DB), so these run as plain unit-style cases under the same file.
// ──────────────────────────────────────────────────────────────────────────

describe("rewriteBriefPathToSpec (b-105 / dec-6, std-10)", () => {
  it("doc-only: /<ns>/<mx>/briefs/b-N → /<ns>/<mx>/specs/spec-N (301)", () => {
    const result = rewriteBriefPathToSpec("mindset/team/briefs/b-12");
    expect(result).toEqual({
      destination: "mindset/team/specs/spec-12",
      status: 301,
      reason: "brief_to_spec_rename",
    });
  });

  it("decision child: /<ns>/<mx>/briefs/b-N/decisions/dec-M → /<ns>/<mx>/specs/spec-N/decisions/dec-M", () => {
    const result = rewriteBriefPathToSpec("mindset/team/briefs/b-12/decisions/dec-3");
    expect(result).toEqual({
      destination: "mindset/team/specs/spec-12/decisions/dec-3",
      status: 301,
      reason: "brief_to_spec_rename",
    });
  });

  it("task child: /<ns>/<mx>/briefs/b-N/tasks/t-M → /<ns>/<mx>/specs/spec-N/tasks/t-M", () => {
    const result = rewriteBriefPathToSpec("mindset/team/briefs/b-12/tasks/t-7");
    expect(result).toEqual({
      destination: "mindset/team/specs/spec-12/tasks/t-7",
      status: 301,
      reason: "brief_to_spec_rename",
    });
  });

  it("comment child: /<ns>/<mx>/briefs/b-N/comments/c-M → /<ns>/<mx>/specs/spec-N/comments/c-M", () => {
    const result = rewriteBriefPathToSpec("mindset/team/briefs/b-12/comments/c-42");
    expect(result).toEqual({
      destination: "mindset/team/specs/spec-12/comments/c-42",
      status: 301,
      reason: "brief_to_spec_rename",
    });
  });

  it("collection root: /<ns>/<mx>/briefs → /<ns>/<mx>/specs", () => {
    const result = rewriteBriefPathToSpec("mindset/team/briefs");
    expect(result).toEqual({
      destination: "mindset/team/specs",
      status: 301,
      reason: "brief_to_spec_rename",
    });
  });

  it("returns null for paths already in Spec shape", () => {
    expect(rewriteBriefPathToSpec("mindset/team/specs/spec-12")).toBeNull();
    expect(rewriteBriefPathToSpec("mindset/team/specs")).toBeNull();
  });

  it("returns null for non-Spec doc types (docs, standards, execution-plans)", () => {
    expect(rewriteBriefPathToSpec("mindset/team/docs/doc-12")).toBeNull();
    expect(rewriteBriefPathToSpec("mindset/team/standards/std-5")).toBeNull();
    expect(rewriteBriefPathToSpec("mindset/team/execution-plans/doc-3")).toBeNull();
  });
});
