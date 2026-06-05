// spec-136 t-3 — the Specs-view tag filter (listDocs `tags` option). Proves:
//   ac-3  selecting tags narrows the board to Specs carrying them
//   ac-9  resolution is an exact indexed (scope, value) match (not a LIKE/substring),
//         with OR-within-scope and AND-across-scopes facet semantics
//   ac-14 the filter defers to the existing docType predicate rather than hardcoding one
//
// TAGGED with tagAc (@memex-ai-ac/vitest) → emits to the PROD memex; a human runs this.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, tags } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { listDocs } from "./documents.js";
import { applyTagString, parseTagInput } from "./tags.js";
import type { RequestCtx } from "./mutate.js";

const ctx: RequestCtx = {};
const AC = "mindset-prod/memex-building-itself/specs/spec-136/acs";

describe("tag filter on the Specs view [spec-136 t-3]", () => {
  let memexId: string;
  const ids: Record<string, string> = {};

  async function makeSpec(key: string, docType = "spec"): Promise<string> {
    const [doc] = await db
      .insert(documents)
      .values({ memexId, handle: `spec-${key}`, title: key, docType })
      .returning();
    ids[key] = doc.id;
    return doc.id;
  }

  beforeAll(async () => {
    memexId = await makeTestMemex("tagfilter");
    // A: priority::high + area::mcp   B: priority::critical + area::mcp
    // C: priority::low                E: priority::higher (substring trap)
    // D: flat bug + frontend          F: a non-spec doc carrying area::mcp
    await makeSpec("A");
    await makeSpec("B");
    await makeSpec("C");
    await makeSpec("D");
    await makeSpec("E");
    await makeSpec("F", "document");

    await applyTagString(ctx, memexId, ids.A, "priority::high");
    await applyTagString(ctx, memexId, ids.A, "area::mcp");
    await applyTagString(ctx, memexId, ids.B, "priority::critical");
    await applyTagString(ctx, memexId, ids.B, "area::mcp");
    await applyTagString(ctx, memexId, ids.C, "priority::low");
    await applyTagString(ctx, memexId, ids.D, "bug");
    await applyTagString(ctx, memexId, ids.D, "frontend");
    await applyTagString(ctx, memexId, ids.E, "priority::higher");
    await applyTagString(ctx, memexId, ids.F, "area::mcp");
  });

  afterAll(async () => {
    for (const id of Object.values(ids)) await db.delete(documents).where(eq(documents.id, id));
    await db.delete(tags).where(eq(tags.memexId, memexId));
  });

  // docType defaults to "spec"; pass `null` to OMIT the docType predicate entirely
  // (a `null` sentinel, not `undefined` — `undefined` would trigger the default).
  async function filter(tagStrings: string[], docType: string | null = "spec"): Promise<string[]> {
    const opts: { docType?: string; tags: ReturnType<typeof parseTagInput>[] } = {
      tags: tagStrings.map(parseTagInput),
    };
    if (docType !== null) opts.docType = docType;
    const rows = await listDocs(memexId, opts);
    return rows.map((r) => r.id).sort();
  }

  it("ac-3: selecting a tag narrows the board to Specs carrying it", async () => {
    tagAc(`${AC}/ac-3`);
    expect(await filter(["area::mcp"])).toEqual([ids.A, ids.B].sort());
  });

  it("ac-9: OR within a single scope", async () => {
    tagAc(`${AC}/ac-9`);
    // priority::high OR priority::critical → A and B (not C/low, not E/higher).
    expect(await filter(["priority::high", "priority::critical"])).toEqual([ids.A, ids.B].sort());
  });

  it("ac-9: AND across different scopes", async () => {
    tagAc(`${AC}/ac-9`);
    // priority::high AND area::mcp → only A (B is area::mcp but priority::critical).
    expect(await filter(["priority::high", "area::mcp"])).toEqual([ids.A]);
  });

  it("ac-9: exact (scope, value) match — NOT a LIKE/substring", async () => {
    tagAc(`${AC}/ac-9`);
    // Filtering priority::high must not match priority::higher (E).
    const res = await filter(["priority::high"]);
    expect(res).toEqual([ids.A]);
    expect(res).not.toContain(ids.E);
  });

  it("ac-9: flat tags are ANDed; a non-existent tag yields nothing", async () => {
    tagAc(`${AC}/ac-9`);
    expect(await filter(["bug", "frontend"])).toEqual([ids.D]);
    expect(await filter(["bug", "nope-not-a-tag"])).toEqual([]);
    expect(await filter(["priority::does-not-exist"])).toEqual([]);
  });

  it("ac-14: filter defers to the existing docType predicate, not a hardcoded literal", async () => {
    tagAc(`${AC}/ac-14`);
    // With docType='spec', the non-spec doc F (also tagged area::mcp) is excluded by the
    // EXISTING docType predicate — A, B only.
    expect(await filter(["area::mcp"], "spec")).toEqual([ids.A, ids.B].sort());
    // Drop the docType predicate (null) and the SAME tag filter now includes F — proving
    // the tag filter itself imposes no docType, so the Specs view's own predicate is the
    // single source of truth for what counts as a Spec.
    expect(await filter(["area::mcp"], null)).toEqual([ids.A, ids.B, ids.F].sort());
  });
});
