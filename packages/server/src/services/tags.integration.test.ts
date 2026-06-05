// spec-136 t-2 — tag service: create-or-pick, set-tags, per-scope mutual exclusivity.
// Hits the local dev DB via makeTestMemex. Proves the behavioural half of the spec's
// implementation ACs (ac-7 canonicalisation, ac-8 mutual exclusivity, ac-12 idempotency)
// at the service layer; the schema half lives in __regression__/tags-schema.regression.test.ts.
//
// TAGGED with tagAc (@memex-ai-ac/vitest) → emits to the PROD memex; a human runs this.
// Adapted to develop: attribution is the single `added_by` column (a userId string|null),
// not the pre-develop author_user_id/author_name/author_namespace_id trio.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, tags, documentTags } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import {
  parseTagInput,
  formatTag,
  getOrCreateTag,
  setTagOnDoc,
  removeTagFromDoc,
  listDocTags,
  applyTagString,
} from "./tags.js";
import type { RequestCtx } from "./mutate.js";

const ctx: RequestCtx = {};

const AC = "mindset-prod/memex-building-itself/specs/spec-136/acs";

describe("tags service [spec-136 t-2]", () => {
  let memexId: string;
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    memexId = await makeTestMemex("tagsvc");
  });

  afterAll(async () => {
    for (const id of createdDocIds) await db.delete(documents).where(eq(documents.id, id));
    await db.delete(tags).where(eq(tags.memexId, memexId));
  });

  async function makeDoc(handle: string): Promise<string> {
    const [doc] = await db
      .insert(documents)
      .values({ memexId, handle, title: handle, docType: "spec" })
      .returning();
    createdDocIds.push(doc.id);
    return doc.id;
  }

  // ── parseTagInput / formatTag ─────────────────────────────────────────────
  describe("parseTagInput", () => {
    it("parses a scoped tag on the first `::`", () => {
      expect(parseTagInput("priority::high")).toEqual({ scope: "priority", value: "high" });
      expect(parseTagInput("a::b::c")).toEqual({ scope: "a", value: "b::c" });
    });
    it("treats a string with no `::` as a flat tag (scope = null)", () => {
      expect(parseTagInput("bug")).toEqual({ scope: null, value: "bug" });
    });
    it("trims and treats an empty scope as flat", () => {
      expect(parseTagInput("  frontend  ")).toEqual({ scope: null, value: "frontend" });
      expect(parseTagInput("::high")).toEqual({ scope: null, value: "high" });
    });
    it("rejects empty input and empty value", () => {
      expect(() => parseTagInput("   ")).toThrow();
      expect(() => parseTagInput("priority::")).toThrow();
    });
    it("round-trips through formatTag", () => {
      expect(formatTag({ scope: "size", value: "M" })).toBe("size::M");
      expect(formatTag({ scope: null, value: "bug" })).toBe("bug");
    });
  });

  // ── ac-7: create-or-pick canonicalisation ────────────────────────────────
  it("ac-7: getOrCreateTag returns the SAME row for a repeated scoped tag", async () => {
    tagAc(`${AC}/ac-7`);
    const a = await getOrCreateTag(ctx, memexId, "priority", "high");
    const b = await getOrCreateTag(ctx, memexId, "priority", "high");
    expect(b.id).toBe(a.id);
    const rows = await db
      .select()
      .from(tags)
      .where(and(eq(tags.memexId, memexId), eq(tags.scope, "priority"), eq(tags.value, "high")));
    expect(rows.length).toBe(1);
  });

  it("ac-7: getOrCreateTag canonicalises flat tags (scope = null) to one row", async () => {
    tagAc(`${AC}/ac-7`);
    const a = await getOrCreateTag(ctx, memexId, null, "bug");
    const b = await getOrCreateTag(ctx, memexId, null, "bug");
    expect(b.id).toBe(a.id);
    expect(a.scope).toBeNull();
  });

  // ── ac-8: per-scope mutual exclusivity ────────────────────────────────────
  it("ac-8: applying a new value in a scope replaces the previous value on that Spec", async () => {
    tagAc(`${AC}/ac-8`);
    const docId = await makeDoc("spec-mutex");
    const high = await getOrCreateTag(ctx, memexId, "priority", "high");
    const low = await getOrCreateTag(ctx, memexId, "priority", "low");

    await setTagOnDoc(ctx, memexId, docId, high);
    let current = await listDocTags(memexId, docId);
    expect(current.map((t) => t.value)).toEqual(["high"]);

    // Applying priority::low must swap out priority::high (same scope).
    await setTagOnDoc(ctx, memexId, docId, low);
    current = await listDocTags(memexId, docId);
    const priority = current.filter((t) => t.scope === "priority");
    expect(priority.length).toBe(1);
    expect(priority[0].value).toBe("low");
  });

  it("ac-8: flat tags are multi-valued and never displaced by a scoped apply", async () => {
    tagAc(`${AC}/ac-8`);
    const docId = await makeDoc("spec-flat");
    const bug = await getOrCreateTag(ctx, memexId, null, "bug");
    const frontend = await getOrCreateTag(ctx, memexId, null, "frontend");
    const sizeM = await getOrCreateTag(ctx, memexId, "size", "M");

    await setTagOnDoc(ctx, memexId, docId, bug);
    await setTagOnDoc(ctx, memexId, docId, frontend);
    await setTagOnDoc(ctx, memexId, docId, sizeM);

    const current = await listDocTags(memexId, docId);
    const flatValues = current.filter((t) => t.scope === null).map((t) => t.value).sort();
    expect(flatValues).toEqual(["bug", "frontend"]);
    expect(current.some((t) => t.scope === "size" && t.value === "M")).toBe(true);
  });

  // ── ac-12: idempotent assignment ──────────────────────────────────────────
  it("ac-12: applying the same tag twice is idempotent (one link)", async () => {
    tagAc(`${AC}/ac-12`);
    const docId = await makeDoc("spec-idem");
    const tag = await getOrCreateTag(ctx, memexId, "area", "mcp");

    const first = await setTagOnDoc(ctx, memexId, docId, tag);
    const second = await setTagOnDoc(ctx, memexId, docId, tag);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // conflict → no new row

    const links = await db
      .select()
      .from(documentTags)
      .where(and(eq(documentTags.docId, docId), eq(documentTags.tagId, tag.id)));
    expect(links.length).toBe(1);
  });

  // ── removeTagFromDoc ──────────────────────────────────────────────────────
  it("removeTagFromDoc drops the link and reports the count", async () => {
    const docId = await makeDoc("spec-remove");
    const tag = await getOrCreateTag(ctx, memexId, null, "removable");
    await setTagOnDoc(ctx, memexId, docId, tag);

    const res = await removeTagFromDoc(ctx, memexId, docId, tag.id);
    expect(res.removed).toBe(1);
    expect(await listDocTags(memexId, docId)).toEqual([]);

    // Removing again is a no-op.
    const again = await removeTagFromDoc(ctx, memexId, docId, tag.id);
    expect(again.removed).toBe(0);
  });

  // ── applyTagString (the MCP entry point) + same-tenant guard ──────────────
  it("applyTagString parses, creates, and attaches in one call — recording added_by", async () => {
    const docId = await makeDoc("spec-apply");
    // added_by FKs users(id) ON DELETE SET NULL — use a real user so the FK holds and
    // we can assert the single denormalised attribution column (develop's doc_assignees
    // parallel, not the pre-develop author_* trio).
    // Reserved test TLD (RFC 2606) so this fixture is excluded from the
    // migration-smoke namespace_id invariant — a bare @memex.ai email leaks
    // past that production-data check as a NULL-namespace active user.
    const author = await upsertUserByEmail("tagger@example.com");
    const tag = await applyTagString(ctx, memexId, docId, "team::platform", author.id);
    expect(tag.scope).toBe("team");
    expect(tag.value).toBe("platform");

    const link = await db
      .select()
      .from(documentTags)
      .where(and(eq(documentTags.docId, docId), eq(documentTags.tagId, tag.id)));
    expect(link.length).toBe(1);
    expect(link[0].addedBy).toBe(author.id);
  });

  it("applyTagString rejects a Spec that isn't in this Memex (same-tenant invariant)", async () => {
    const otherMemexId = await makeTestMemex("tagsvc-other");
    const [foreignDoc] = await db
      .insert(documents)
      .values({ memexId: otherMemexId, handle: "spec-foreign", title: "foreign", docType: "spec" })
      .returning();

    await expect(
      applyTagString(ctx, memexId, foreignDoc.id, "priority::high"),
    ).rejects.toThrow(/not found in this Memex/);

    await db.delete(documents).where(eq(documents.id, foreignDoc.id));
  });
});
