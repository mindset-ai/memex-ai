// spec-136 t-1 — schema + behavioural guarantees for the `tags` / `document_tags`
// tables introduced by migration 0070_add_tags.
//
// Runs against the local dev DB (like the other __regression__ specs). Each `it`
// names the spec-136 implementation AC it proves:
//   ac-6  structured {scope, value}; flat tag = scope NULL
//   ac-7  unique(memex_id, scope, value) canonicalises (incl. NULLS NOT DISTINCT for flat tags)
//   ac-10 document_tags.document_id FK to documents(id) ON DELETE CASCADE — no orphans
//   ac-11 no polymorphic object_type/object_id; references documents only
//   ac-12 unique(document_id, tag_id) — a Spec can't carry the same tag twice
//   ac-13 both tables carry memex_id; indexes on (memex_id, document_id) and (memex_id, tag_id)
//
// TAGGED with tagAc (@memex-ai-ac/vitest) → reports pass/fail to the PROD memex
// (the spec lives at mindset-prod/…). A human runs this; auto mode skips tagged suites.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, tags, documentTags } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";

// Canonical AC ref prefix for spec-136 (routes emissions to prod per its namespace).
const AC = "mindset-prod/memex-building-itself/specs/spec-136/acs";

describe("regression: tags schema [spec-136 t-1]", () => {
  let memexId: string;
  const createdTagIds: string[] = [];
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    memexId = await makeTestMemex("tags");
  });

  afterAll(async () => {
    // Deleting the document cascades its document_tags rows; tags are deleted explicitly.
    for (const id of createdDocIds) await db.delete(documents).where(eq(documents.id, id));
    for (const id of createdTagIds) await db.delete(tags).where(eq(tags.id, id));
  });

  async function makeDoc(handle: string): Promise<string> {
    const [doc] = await db
      .insert(documents)
      .values({ memexId, handle, title: handle, docType: "spec" })
      .returning();
    createdDocIds.push(doc.id);
    return doc.id;
  }

  // ── ac-6 ────────────────────────────────────────────────────────────────
  it("ac-6: a tag stores a nullable scope + non-null value; a flat tag has scope = NULL", async () => {
    tagAc(`${AC}/ac-6`);
    const [scoped] = await db
      .insert(tags)
      .values({ memexId, scope: "priority", value: "high" })
      .returning();
    const [flat] = await db
      .insert(tags)
      .values({ memexId, scope: null, value: "bug" })
      .returning();
    createdTagIds.push(scoped.id, flat.id);

    expect(scoped.scope).toBe("priority");
    expect(scoped.value).toBe("high");
    expect(flat.scope).toBeNull();
    expect(flat.value).toBe("bug");
  });

  // ── ac-7 ────────────────────────────────────────────────────────────────
  it("ac-7: unique(memex_id, scope, value) rejects a duplicate scoped tag in the same Memex", async () => {
    tagAc(`${AC}/ac-7`);
    const [t] = await db
      .insert(tags)
      .values({ memexId, scope: "size", value: "M" })
      .returning();
    createdTagIds.push(t.id);

    await expect(
      db.insert(tags).values({ memexId, scope: "size", value: "M" })
    ).rejects.toThrow();
  });

  it("ac-7: NULLS NOT DISTINCT rejects a second flat tag with the same value (two `frontend` collide)", async () => {
    tagAc(`${AC}/ac-7`);
    const [t] = await db
      .insert(tags)
      .values({ memexId, scope: null, value: "frontend" })
      .returning();
    createdTagIds.push(t.id);

    // Without NULLS NOT DISTINCT, scope = NULL would make these two rows distinct
    // (NULL <> NULL) and the duplicate would be allowed — defeating canonicalisation.
    await expect(
      db.insert(tags).values({ memexId, scope: null, value: "frontend" })
    ).rejects.toThrow();
  });

  // ── ac-12 ───────────────────────────────────────────────────────────────
  it("ac-12: unique(document_id, tag_id) makes a repeat assignment idempotent (rejects the duplicate)", async () => {
    tagAc(`${AC}/ac-12`);
    const docId = await makeDoc("spec-ac12");
    const [tag] = await db
      .insert(tags)
      .values({ memexId, scope: "area", value: "mcp" })
      .returning();
    createdTagIds.push(tag.id);

    await db.insert(documentTags).values({ memexId, docId, tagId: tag.id });

    await expect(
      db.insert(documentTags).values({ memexId, docId, tagId: tag.id })
    ).rejects.toThrow();
  });

  // ── ac-10 ───────────────────────────────────────────────────────────────
  it("ac-10: deleting a Spec cascade-deletes its document_tags links (no orphans)", async () => {
    tagAc(`${AC}/ac-10`);
    const docId = await makeDoc("spec-ac10");
    const [tag] = await db
      .insert(tags)
      .values({ memexId, scope: "team", value: "platform" })
      .returning();
    createdTagIds.push(tag.id);
    await db.insert(documentTags).values({ memexId, docId, tagId: tag.id });

    // Sanity: the link exists.
    const before = await db
      .select()
      .from(documentTags)
      .where(eq(documentTags.docId, docId));
    expect(before.length).toBe(1);

    // Delete the Spec — the FK ON DELETE CASCADE must remove the link automatically.
    await db.delete(documents).where(eq(documents.id, docId));
    createdDocIds.splice(createdDocIds.indexOf(docId), 1); // already gone

    const after = await db
      .select()
      .from(documentTags)
      .where(eq(documentTags.docId, docId));
    expect(after.length).toBe(0);

    // The tag itself survives (it is catalogue data, not a link).
    const tagStill = await db.select().from(tags).where(eq(tags.id, tag.id));
    expect(tagStill.length).toBe(1);
  });

  // ── ac-11 ───────────────────────────────────────────────────────────────
  it("ac-11: document_tags has no polymorphic object_type/object_id columns", async () => {
    tagAc(`${AC}/ac-11`);
    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'document_tags'
    `);
    const names = (cols as unknown as { column_name: string }[]).map((r) => r.column_name);
    expect(names).not.toContain("object_type");
    expect(names).not.toContain("object_id");
    // Positive assertion: it targets the documents table via a real FK column.
    expect(names).toContain("document_id");
  });

  // ── ac-13 ───────────────────────────────────────────────────────────────
  it("ac-13: both tables carry a memex_id column (tenant key on every row)", async () => {
    tagAc(`${AC}/ac-13`);
    for (const table of ["tags", "document_tags"]) {
      const cols = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = ${table} AND column_name = 'memex_id'
      `);
      expect(
        (cols as unknown as unknown[]).length,
        `${table} missing memex_id`
      ).toBe(1);
    }
  });

  it("ac-13: document_tags has indexes on (memex_id, document_id) and (memex_id, tag_id)", async () => {
    tagAc(`${AC}/ac-13`);
    const idx = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'document_tags'
    `);
    const defs = (idx as unknown as { indexname: string; indexdef: string }[]);

    const hasMemexDoc = defs.some(
      (d) => /\(memex_id,\s*document_id\)/.test(d.indexdef)
    );
    const hasMemexTag = defs.some(
      (d) => /\(memex_id,\s*tag_id\)/.test(d.indexdef)
    );
    expect(hasMemexDoc, "missing index on (memex_id, document_id)").toBe(true);
    expect(hasMemexTag, "missing index on (memex_id, tag_id)").toBe(true);
  });
});
