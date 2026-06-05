// spec-136 — tenant-isolation regression for the tag write path. UNTAGGED (no AC
// emission): this guards the same-tenant invariant (spec-125), not a named AC.
// Added after a code review found removeTagFromDoc deleted by (docId, tagId) with no
// memexId predicate — a cross-tenant write gap.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, tags } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { getOrCreateTag, setTagOnDoc, removeTagFromDoc, listDocTags } from "./tags.js";
import type { RequestCtx } from "./mutate.js";

const ctx: RequestCtx = {};

describe("tags tenant isolation [spec-136]", () => {
  let memexA: string;
  let memexB: string;
  let docB: string;
  let tagB: string;

  beforeAll(async () => {
    memexA = await makeTestMemex("tenantA");
    memexB = await makeTestMemex("tenantB");
    const [doc] = await db
      .insert(documents)
      .values({ memexId: memexB, handle: "spec-b", title: "B", docType: "spec" })
      .returning();
    docB = doc.id;
    const tag = await getOrCreateTag(ctx, memexB, "priority", "high");
    tagB = tag.id;
    await setTagOnDoc(ctx, memexB, docB, tag);
  });

  afterAll(async () => {
    await db.delete(documents).where(eq(documents.id, docB));
    await db.delete(tags).where(eq(tags.memexId, memexB));
    await db.delete(tags).where(eq(tags.memexId, memexA));
  });

  it("removeTagFromDoc with a FOREIGN memexId is a no-op (cannot delete another tenant's link)", async () => {
    // A caller scoped to memex A passes memex B's docId + tagId.
    const res = await removeTagFromDoc(ctx, memexA, docB, tagB);
    expect(res.removed).toBe(0);
    // The link in memex B must survive.
    expect((await listDocTags(memexB, docB)).map((t) => t.value)).toEqual(["high"]);
  });

  it("removeTagFromDoc with the CORRECT memexId removes the link", async () => {
    const res = await removeTagFromDoc(ctx, memexB, docB, tagB);
    expect(res.removed).toBe(1);
    expect(await listDocTags(memexB, docB)).toEqual([]);
  });
});
