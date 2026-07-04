// spec-448 t-5 — per-user "last-seen version" tracking (doc_views) + the
// catch-up derivation used by GET /docs/:id.
//
// ac-8: the marker advances on a web open AND on the viewer's own MCP writes,
//       but NOT on an MCP read (mirrored end-to-end in
//       agent/handlers/docs-view-stamping.integration.test.ts; this file
//       exercises the underlying upsertDocView/computeCatchUp contract directly).
// ac-39: hasCatchUp = a marker row exists AND its lastViewedVersion < the doc's
//        current version.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { docViews, documents, users } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { cutVersion } from "./versioning.js";
import { upsertDocView, getDocView, computeCatchUp } from "./docViews.js";

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-8";
const AC_39 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-39";

const runId = `${process.env.VITEST_POOL_ID ?? "0"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let memexId: string;
let docId: string;
let userAId: string;
let userBId: string;
const createdUserIds: string[] = [];
const createdDocIds: string[] = [];

beforeAll(async () => {
  memexId = await makeTestMemex(`dv-${runId}`);
  const doc = await createDocDraft(memexId, `docViews test spec ${runId}`, "Purpose", "spec");
  docId = doc.id;
  createdDocIds.push(docId);

  const userA = await upsertUserByEmail(`dv-user-a-${runId}@example.com`);
  const userB = await upsertUserByEmail(`dv-user-b-${runId}@example.com`);
  userAId = userA.id;
  userBId = userB.id;
  createdUserIds.push(userAId, userBId);
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

describe("spec-448 t-5: docViews service", () => {
  it("getDocView returns null before any marker exists", async () => {
    const view = await getDocView(userAId, docId);
    expect(view).toBeNull();
  });

  it("upsertDocView creates a marker at the doc's current version (ac-8)", async () => {
    tagAc(AC_8);
    const [doc] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(doc).toBeDefined();

    await upsertDocView({ userId: userAId, docId, memexId, version: doc!.version, channel: "rest_ui" });

    const view = await getDocView(userAId, docId);
    expect(view).not.toBeNull();
    expect(view!.lastViewedVersion).toBe(doc!.version);
    expect(view!.channel).toBe("rest_ui");
  });

  it("upsertDocView is an upsert: a second call with a new channel advances lastViewedAt/channel in place", async () => {
    tagAc(AC_8);
    const before = await getDocView(userAId, docId);
    expect(before).not.toBeNull();

    // Small delay so lastViewedAt is observably different.
    await new Promise((r) => setTimeout(r, 5));
    await upsertDocView({ userId: userAId, docId, memexId, version: before!.lastViewedVersion, channel: "mcp" });

    const after = await getDocView(userAId, docId);
    expect(after).not.toBeNull();
    expect(after!.channel).toBe("mcp");
    expect(after!.lastViewedAt.getTime()).toBeGreaterThan(before!.lastViewedAt.getTime());
  });

  it("computeCatchUp: anonymous (undefined userId) never queries doc_views, always no-catch-up", async () => {
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    const result = await computeCatchUp({ id: docId, version: doc!.version }, undefined);
    expect(result).toEqual({ hasCatchUp: false, fromVersion: null, lastViewedVersion: null });
  });

  it("computeCatchUp: no marker row → hasCatchUp false, lastViewedVersion null", async () => {
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    const result = await computeCatchUp({ id: docId, version: doc!.version }, userBId);
    expect(result).toEqual({ hasCatchUp: false, fromVersion: null, lastViewedVersion: null });
  });

  it("computeCatchUp: marker caught up to current version → hasCatchUp false", async () => {
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    await upsertDocView({ userId: userBId, docId, memexId, version: doc!.version, channel: "rest_ui" });
    const result = await computeCatchUp({ id: docId, version: doc!.version }, userBId);
    expect(result.hasCatchUp).toBe(false);
    expect(result.fromVersion).toBeNull();
    expect(result.lastViewedVersion).toBe(doc!.version);
  });

  it("computeCatchUp: cutting a new version leaves userB's marker behind → hasCatchUp true (ac-39)", async () => {
    tagAc(AC_39);
    const beforeCut = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    const stampedAt = beforeCut!.version;

    await cutVersion(memexId, docId, "docViews test cut", []);

    const afterCut = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    expect(afterCut!.version).toBeGreaterThan(stampedAt);

    const result = await computeCatchUp({ id: docId, version: afterCut!.version }, userBId);
    expect(result.hasCatchUp).toBe(true);
    expect(result.fromVersion).toBe(stampedAt);
    expect(result.lastViewedVersion).toBe(stampedAt);

    // userA never re-viewed after their earlier stamp either — same shape.
    const resultA = await computeCatchUp({ id: docId, version: afterCut!.version }, userAId);
    expect(resultA.hasCatchUp).toBe(true);
    expect(resultA.fromVersion).toBe(stampedAt);
  });

  it("a fresh upsertDocView after the cut catches the user back up", async () => {
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    await upsertDocView({ userId: userBId, docId, memexId, version: doc!.version, channel: "mcp" });
    const result = await computeCatchUp({ id: docId, version: doc!.version }, userBId);
    expect(result.hasCatchUp).toBe(false);
  });

  it("userA and userB each see only their OWN marker (owner isolation, ac-38's service-layer face)", async () => {
    const a = await getDocView(userAId, docId);
    const b = await getDocView(userBId, docId);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Both rows exist independently keyed on (userId, docId) — confirmed via the
    // dedicated RLS proof (db/spec-448-document-versioning-rls.test.ts, ac-38);
    // this just confirms the service layer reads each user's own row correctly.
    const rows = await db.select().from(docViews).where(eq(docViews.docId, docId));
    expect(rows.map((r) => r.userId).sort()).toEqual([userAId, userBId].sort());
  });
});
