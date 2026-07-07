// spec-418 t-2 — tag CURATION service: create / rename / delete + guards + counts.
//
// createTag/renameTag/deleteTag are the catalogue-admin mutations (t-2). Distinct
// from the create-or-pick attach path (getOrCreateTag/applyTagString, spec-136):
//   * createTag BLOCKS on a duplicate (getOrCreateTag silently returns the existing).
//   * renameTag guards duplicate-name (ac-13) and per-scope exclusivity (ac-14),
//     races-safe at the CI unique index (ac-38), NO merge (dec-2).
//   * deleteTag NEVER blocks; cascade drops document_tags links; blast-radius count
//     returned to the caller (ac-15).
//   * listMemexTagsWithCounts computes per-tag assigned counts in ONE aggregate (ac-18).
//
// Every write goes through mutate() (std-8) with a RequestCtx so channel attribution
// is correct (std-32/ac-19). Curation of a tag ON N Specs emits N `document` updated
// events + 1 `tag` event via mutate()'s array-of-keys, all in one call (ac-16/ac-39).
//
// TAGGED with tagAc (@memex-ai-ac/vitest) → emits to the PROD memex; a human runs this.
// Fixture-isolated per std-37 (makeTestMemex mints a unique tenant per case).

import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, tags, documentTags } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";
import { ValidationError } from "../types/errors.js";
import {
  createTag,
  renameTag,
  deleteTag,
  listMemexTagsWithCounts,
  getOrCreateTag,
  setTagOnDoc,
} from "./tags.js";
import * as tagsSvc from "./tags.js";
import type { RequestCtx } from "./mutate.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-418/acs";
const ctx: RequestCtx = { channel: "rest_ui" };

async function makeDoc(memexId: string, handle: string): Promise<string> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title: handle, docType: "spec" })
    .returning();
  return doc.id;
}

/** Capture bus events for a memex until unsubscribed. */
function captureEvents(memexId: string): { events: ChangeEvent[]; stop: () => void } {
  const events: ChangeEvent[] = [];
  const unsub = bus.subscribe({ memexId }, (e) => events.push(e));
  return { events, stop: unsub };
}

// ── ac-27 / ac-29: createTag mints a catalogue row, no Spec-exclusivity path ──
describe("createTag [spec-418 t-2]", () => {
  it("ac-27: mints a tags row with ZERO document_tags links", async () => {
    tagAc(`${AC}/ac-27`);
    const memexId = await makeTestMemex("t2c27");
    const tag = await createTag(ctx, memexId, "area", "billing");
    expect(tag.scope).toBe("area");
    expect(tag.value).toBe("billing");

    const row = await db.select().from(tags).where(eq(tags.id, tag.id));
    expect(row.length).toBe(1);
    const links = await db
      .select()
      .from(documentTags)
      .where(eq(documentTags.tagId, tag.id));
    expect(links.length).toBe(0);
  });

  it("ac-27: createTag of a CI-variant of an existing tag throws NAMING the existing", async () => {
    tagAc(`${AC}/ac-27`);
    const memexId = await makeTestMemex("t2c27b");
    const orig = await createTag(ctx, memexId, "area", "Billing");
    await expect(createTag(ctx, memexId, "AREA", "billing")).rejects.toThrow(
      /area::Billing/,
    );
    // No second row minted.
    const all = await db.select().from(tags).where(eq(tags.memexId, memexId));
    expect(all.length).toBe(1);
    expect(all[0].id).toBe(orig.id);
  });

  it("ac-29: create is blocked ONLY by duplicate-name — never a per-scope exclusivity block", async () => {
    tagAc(`${AC}/ac-29`);
    const memexId = await makeTestMemex("t2c29");
    // Seed the memex so the `priority` scope is already carried on a Spec.
    const docId = await makeDoc(memexId, "spec-a");
    const high = await getOrCreateTag(ctx, memexId, "priority", "high");
    await setTagOnDoc(ctx, memexId, docId, high);

    // A NEW catalogue tag in that SAME scope must still succeed — a new tag is on
    // no Spec, so the scope-exclusivity guard can never fire on create.
    const low = await createTag(ctx, memexId, "priority", "low");
    expect(low.scope).toBe("priority");
    expect(low.value).toBe("low");
    const links = await db
      .select()
      .from(documentTags)
      .where(eq(documentTags.tagId, low.id));
    expect(links.length).toBe(0);
  });
});

// ── ac-13: rename onto an existing (scope,value) is rejected, no row changed ──
describe("renameTag duplicate guard [spec-418 t-2]", () => {
  it("ac-13: rename onto an existing tag (incl. case-variant) throws naming it; NO row changed", async () => {
    tagAc(`${AC}/ac-13`);
    const memexId = await makeTestMemex("t2r13");
    const alpha = await createTag(ctx, memexId, null, "alpha");
    await createTag(ctx, memexId, null, "beta");

    // Exact-name collision.
    await expect(renameTag(ctx, memexId, alpha.id, null, "beta")).rejects.toThrow(
      /beta/,
    );
    // Case-variant collision (CI index treats BETA == beta).
    await expect(renameTag(ctx, memexId, alpha.id, null, "BETA")).rejects.toThrow(
      /beta/i,
    );

    // alpha is UNCHANGED after both rejected renames.
    const [reloaded] = await db.select().from(tags).where(eq(tags.id, alpha.id));
    expect(reloaded.scope).toBeNull();
    expect(reloaded.value).toBe("alpha");
  });
});

// ── ac-14: rename that would put two values of one scope on some Spec ─────────
describe("renameTag scope-exclusivity guard [spec-418 t-2]", () => {
  it("ac-14: blocks with a reason naming the scope + COUNT of affected Specs (not an enumeration)", async () => {
    tagAc(`${AC}/ac-14`);
    const memexId = await makeTestMemex("t2r14");

    // A flat "review" tag on 3 Specs, each ALSO carrying priority::high.
    const review = await getOrCreateTag(ctx, memexId, null, "review");
    const high = await getOrCreateTag(ctx, memexId, "priority", "high");
    const handles = ["spec-x1", "spec-x2", "spec-x3"];
    for (const h of handles) {
      const docId = await makeDoc(memexId, h);
      await setTagOnDoc(ctx, memexId, docId, review);
      await setTagOnDoc(ctx, memexId, docId, high);
    }

    // Renaming "review" INTO the priority scope would give each of the 3 Specs
    // two priority values (high + urgent) → blocked, count summarised.
    let err: unknown;
    try {
      await renameTag(ctx, memexId, review.id, "priority", "urgent");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    const msg = (err as Error).message;
    expect(msg).toContain("priority"); // names the scope
    expect(msg).toMatch(/\b3\b/); // summarises the count
    // Does NOT enumerate each Spec's handle/title.
    for (const h of handles) expect(msg).not.toContain(h);

    // No row changed.
    const [reloaded] = await db.select().from(tags).where(eq(tags.id, review.id));
    expect(reloaded.scope).toBeNull();
    expect(reloaded.value).toBe("review");
  });
});

// ── ac-38: lost check-then-write race maps 23505 to the duplicate block ───────
describe("renameTag race [spec-418 t-2]", () => {
  it("ac-38: two renames to the SAME new (scope,value) → one wins, other = mapped duplicate error (never raw 23505)", async () => {
    tagAc(`${AC}/ac-38`);

    // Loop a few times to make the race deterministic enough to observe.
    for (let attempt = 0; attempt < 3; attempt++) {
      const memexId = await makeTestMemex("t2r38");
      const a = await createTag(ctx, memexId, null, "race-a");
      const b = await createTag(ctx, memexId, null, "race-b");

      const results = await Promise.allSettled([
        renameTag(ctx, memexId, a.id, "sev", "target"),
        renameTag(ctx, memexId, b.id, "sev", "target"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const reason = (rejected[0] as PromiseRejectedResult).reason;
      // Mapped plain-reason DUPLICATE error, NOT a raw Postgres error string.
      expect(reason).toBeInstanceOf(ValidationError);
      expect((reason as Error).message).toMatch(/already exists/);
      expect((reason as Error).message).not.toMatch(/23505|duplicate key|violates/);
    }
  });
});

// ── ac-15: delete always removes; cascade drops links; blast radius returned ──
describe("deleteTag [spec-418 t-2]", () => {
  it("ac-15: deletes the tag + its links (zero orphans); other tags on the Specs survive", async () => {
    tagAc(`${AC}/ac-15`);
    const memexId = await makeTestMemex("t2d15");

    const x = await getOrCreateTag(ctx, memexId, null, "doomed");
    const y = await getOrCreateTag(ctx, memexId, null, "keeper");
    const d1 = await makeDoc(memexId, "spec-d1");
    const d2 = await makeDoc(memexId, "spec-d2");
    await setTagOnDoc(ctx, memexId, d1, x);
    await setTagOnDoc(ctx, memexId, d1, y);
    await setTagOnDoc(ctx, memexId, d2, x);

    const res = await deleteTag(ctx, memexId, x.id);
    expect(res.removed).toBe(1);
    expect(res.affectedDocIds.sort()).toEqual([d1, d2].sort()); // blast radius

    // Tag row gone.
    const gone = await db.select().from(tags).where(eq(tags.id, x.id));
    expect(gone.length).toBe(0);
    // Links gone — zero orphans referencing the deleted tag id.
    const orphanLinks = await db
      .select()
      .from(documentTags)
      .where(eq(documentTags.tagId, x.id));
    expect(orphanLinks.length).toBe(0);
    // Specs survive with their OTHER tag intact.
    expect((await db.select().from(documents).where(eq(documents.id, d1))).length).toBe(1);
    expect((await db.select().from(documents).where(eq(documents.id, d2))).length).toBe(1);
    const d1Links = await db
      .select()
      .from(documentTags)
      .where(and(eq(documentTags.docId, d1), eq(documentTags.tagId, y.id)));
    expect(d1Links.length).toBe(1);
  });

  it("ac-15: deleting an UNUSED (orphan) tag also succeeds — never blocks", async () => {
    tagAc(`${AC}/ac-15`);
    const memexId = await makeTestMemex("t2d15b");
    const orphan = await createTag(ctx, memexId, null, "unused");
    const res = await deleteTag(ctx, memexId, orphan.id);
    expect(res.removed).toBe(1);
    expect(res.affectedDocIds.length).toBe(0);
    expect((await db.select().from(tags).where(eq(tags.id, orphan.id))).length).toBe(0);
  });
});

// ── ac-16 / ac-39 / ac-19: one event per affected Spec + one tag event, atomic, attributed ──
describe("curation events [spec-418 t-2]", () => {
  it("ac-16/ac-39/ac-19: rename on N Specs emits N document + 1 tag events, all carrying ctx.channel", async () => {
    tagAc(`${AC}/ac-16`);
    tagAc(`${AC}/ac-39`);
    tagAc(`${AC}/ac-19`);
    const memexId = await makeTestMemex("t2e16");

    const tag = await getOrCreateTag(ctx, memexId, null, "movable");
    const docIds: string[] = [];
    for (const h of ["spec-e1", "spec-e2"]) {
      const docId = await makeDoc(memexId, h);
      await setTagOnDoc(ctx, memexId, docId, tag);
      docIds.push(docId);
    }

    const cap = captureEvents(memexId);
    await renameTag(ctx, memexId, tag.id, null, "moved");
    cap.stop();

    const docEvents = cap.events.filter(
      (e) => e.entity === "document" && e.action === "updated",
    );
    const tagEvents = cap.events.filter((e) => e.entity === "tag");
    // Exactly one document-updated per affected Spec.
    expect(docEvents.length).toBe(docIds.length);
    expect(docEvents.map((e) => e.docId).sort()).toEqual([...docIds].sort());
    // Exactly one tag event, action updated.
    expect(tagEvents.length).toBe(1);
    expect(tagEvents[0].action).toBe("updated");
    // All curation events carry the originating channel (attribution, std-32).
    for (const e of [...docEvents, ...tagEvents]) expect(e.channel).toBe("rest_ui");
  });

  it("ac-16/ac-19: delete on N Specs emits 1 tag deleted + N document updated, all attributed", async () => {
    tagAc(`${AC}/ac-16`);
    tagAc(`${AC}/ac-19`);
    const memexId = await makeTestMemex("t2e16b");

    const tag = await getOrCreateTag(ctx, memexId, null, "sweepable");
    const docIds: string[] = [];
    for (const h of ["spec-f1", "spec-f2"]) {
      const docId = await makeDoc(memexId, h);
      await setTagOnDoc(ctx, memexId, docId, tag);
      docIds.push(docId);
    }

    const cap = captureEvents(memexId);
    await deleteTag(ctx, memexId, tag.id);
    cap.stop();

    const docEvents = cap.events.filter(
      (e) => e.entity === "document" && e.action === "updated",
    );
    const tagEvents = cap.events.filter((e) => e.entity === "tag");
    expect(docEvents.length).toBe(docIds.length);
    expect(docEvents.map((e) => e.docId).sort()).toEqual([...docIds].sort());
    expect(tagEvents.length).toBe(1);
    expect(tagEvents[0].action).toBe("deleted");
    for (const e of [...docEvents, ...tagEvents]) expect(e.channel).toBe("rest_ui");
  });
});

// ── ac-18: catalogue read computes per-tag counts in a single aggregate ───────
describe("listMemexTagsWithCounts [spec-418 t-2]", () => {
  it("ac-18: returns correct assignedCount per tag (3-Spec tag → 3, orphan → 0)", async () => {
    tagAc(`${AC}/ac-18`);
    const memexId = await makeTestMemex("t2l18");

    const busy = await getOrCreateTag(ctx, memexId, "area", "busy");
    const orphan = await getOrCreateTag(ctx, memexId, null, "orphan");
    for (const h of ["spec-l1", "spec-l2", "spec-l3"]) {
      const docId = await makeDoc(memexId, h);
      await setTagOnDoc(ctx, memexId, docId, busy);
    }

    const rows = await listMemexTagsWithCounts(memexId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(busy.id)?.assignedCount).toBe(3);
    expect(byId.get(orphan.id)?.assignedCount).toBe(0);
    // Ordered scope-then-value (nulls-first ordering leaves the flat "orphan" and the
    // scoped "area::busy" both present; we assert both rows exist).
    expect(rows.length).toBe(2);
  });
});

// ── ac-11 / ac-12: exactly {create, rename, delete}; NO merge function exists ──
describe("curation surface [spec-418 t-2]", () => {
  it("ac-11/ac-12: create/rename/delete are functions; NO mergeTag exists", () => {
    tagAc(`${AC}/ac-11`);
    tagAc(`${AC}/ac-12`);
    expect(typeof tagsSvc.createTag).toBe("function");
    expect(typeof tagsSvc.renameTag).toBe("function");
    expect(typeof tagsSvc.deleteTag).toBe("function");
    expect((tagsSvc as Record<string, unknown>).mergeTag).toBeUndefined();
    expect((tagsSvc as Record<string, unknown>).mergeTags).toBeUndefined();
  });
});

// ── ac-37: create & rename validate input BEFORE any write ────────────────────
describe("curation input validation [spec-418 t-2]", () => {
  it("ac-37: createTag rejects empty-after-trim / over-length / control chars, no row created", async () => {
    tagAc(`${AC}/ac-37`);
    const memexId = await makeTestMemex("t2v37c");
    const tooLong = "x".repeat(129);

    await expect(createTag(ctx, memexId, null, "   ")).rejects.toBeInstanceOf(ValidationError);
    await expect(createTag(ctx, memexId, null, tooLong)).rejects.toBeInstanceOf(ValidationError);
    await expect(createTag(ctx, memexId, tooLong, "v")).rejects.toBeInstanceOf(ValidationError);
    await expect(createTag(ctx, memexId, null, "badvalue")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createTag(ctx, memexId, "bad scope", "v")).rejects.toBeInstanceOf(
      ValidationError,
    );

    // Nothing was written by any rejected create.
    const all = await db.select().from(tags).where(eq(tags.memexId, memexId));
    expect(all.length).toBe(0);
  });

  it("ac-37: renameTag rejects empty-after-trim / over-length / control chars, no row changed", async () => {
    tagAc(`${AC}/ac-37`);
    const memexId = await makeTestMemex("t2v37r");
    const orig = await createTag(ctx, memexId, "area", "ok");
    const tooLong = "x".repeat(129);

    await expect(renameTag(ctx, memexId, orig.id, "area", "   ")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(renameTag(ctx, memexId, orig.id, "area", tooLong)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(renameTag(ctx, memexId, orig.id, tooLong, "v")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      renameTag(ctx, memexId, orig.id, "area", "badvalue"),
    ).rejects.toBeInstanceOf(ValidationError);

    // Untouched.
    const [reloaded] = await db.select().from(tags).where(eq(tags.id, orig.id));
    expect(reloaded.scope).toBe("area");
    expect(reloaded.value).toBe("ok");
  });
});
