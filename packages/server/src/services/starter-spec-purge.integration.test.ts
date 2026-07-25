// spec-509 dec-1 — the starter-Spec purge, end-to-end against real Postgres.
//
// The sweep deletes every PRISTINE seeded "Understanding Memex" Spec and SPARES any copy
// carrying an engagement signal. Because the deletion is irreversible in prod, the spare
// half is what these tests hammer: each signal gets its own case, so a predicate that
// silently stops matching one of them fails here rather than in production.
//
// Each case builds its OWN personal Memex and scopes the purge to that memex id via
// purgeStarterSpecsForMemex, so the shared per-worker DB's other fixtures are untouched
// and assertions are deterministic under parallel execution (std-37).
//
// Cleanup deletes each namespace (cascading memex → documents → children → user).

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  documents,
  memexes,
  namespaces,
  users,
  docViews,
  docComments,
  documentVersions,
  activityLog,
  testEvents,
  acs,
  docSections,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createAc, buildAcRef } from "./acs.js";
import {
  purgeStarterSpecsForMemex,
  RETIRED_SEED_TITLE,
} from "./starter-spec-purge.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-509/acs/ac-${n}`;

const uniq = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    .toLowerCase()
    .slice(0, 39);

const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdNamespaceIds.length) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
});

/** A personal Memex (kind='user' namespace) with a known owner user. */
async function makePersonalMemex(
  prefix: string,
): Promise<{ memexId: string; ownerUserId: string; nsSlug: string }> {
  const slug = uniq(prefix);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: `${slug}@example.com` } as typeof users.$inferInsert)
      .returning();
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "user", ownerUserId: user.id })
      .returning();
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Personal" })
      .returning();
    createdNamespaceIds.push(ns.id);
    return { memexId: memex.id, ownerUserId: user.id, nsSlug: slug };
  });
}

/**
 * Build a copy shaped exactly like the retired seeder's output: canonical title, a
 * narrative section, a scope AC, and — crucially — created_by_user_id NULL (the
 * system-attribution that identifies a seeded copy). `createdByUserId` is passed through
 * so a test can build the LOOK-ALIKE case: a user's own Spec sharing the title.
 */
async function makeSeedShapedCopy(
  memexId: string,
  createdByUserId?: string,
): Promise<{ docId: string; handle: string }> {
  const created = await createDocDraft(
    memexId,
    RETIRED_SEED_TITLE,
    "This is your first spec — and it is about the system you are now holding.",
    "spec",
    undefined,
    undefined,
    createdByUserId,
    { channel: "server" },
  );
  await addSection(
    memexId,
    created.id,
    "comparison",
    "A ticket and a document are both passive.",
    "How it compares",
    undefined,
    { channel: "server" },
  );
  await createAc(
    {
      memexId,
      briefId: created.id,
      kind: "scope",
      statement: "A new user can read one real Spec in their own workspace.",
    },
    { channel: "server" },
  );
  return { docId: created.id, handle: created.handle };
}

const seededCopiesIn = async (memexId: string): Promise<string[]> => {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, "spec"),
        eq(documents.title, RETIRED_SEED_TITLE),
        isNull(documents.createdByUserId),
      ),
    );
  return rows.map((r) => r.id);
};

const allSpecsIn = async (memexId: string): Promise<string[]> => {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.docType, "spec")));
  return rows.map((r) => r.id);
};

describe("spec-509 — the starter-Spec purge deletes only pristine copies (ac-7 … ac-12)", () => {
  it("deletes a pristine seeded copy (ac-7)", async () => {
    tagAc(AC(7));
    const { memexId } = await makePersonalMemex("purge-pristine");
    const { docId } = await makeSeedShapedCopy(memexId);
    expect(await seededCopiesIn(memexId)).toContain(docId);

    const result = await purgeStarterSpecsForMemex(memexId);

    expect(result.found).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.spared).toEqual([]);
    expect(await seededCopiesIn(memexId)).toEqual([]);
  });

  // dec-1's load-bearing choice: a mere VIEW spares the copy. This is the case that
  // protects the one prod user who opened theirs 51 times.
  it("SPARES a copy someone merely opened, and reports 'viewed' (ac-7 / ac-11)", async () => {
    tagAc(AC(7));
    tagAc(AC(11));
    const { memexId, ownerUserId } = await makePersonalMemex("purge-viewed");
    const { docId } = await makeSeedShapedCopy(memexId);

    await db.insert(docViews).values({
      userId: ownerUserId,
      docId,
      lastViewedVersion: 1,
      lastViewedAt: new Date(),
      channel: "rest_ui",
    });

    const result = await purgeStarterSpecsForMemex(memexId);

    expect(result.deleted).toBe(0);
    expect(result.spared).toHaveLength(1);
    expect(result.spared[0]).toMatchObject({ docId, reason: "viewed" });
    expect(await seededCopiesIn(memexId)).toContain(docId);
  });

  it("SPARES a copy with non-system activity, and reports 'human_activity' (ac-7 / ac-11)", async () => {
    tagAc(AC(7));
    tagAc(AC(11));
    const { memexId, ownerUserId } = await makePersonalMemex("purge-activity");
    const { docId } = await makeSeedShapedCopy(memexId);

    await db.insert(activityLog).values({
      memexId,
      briefId: docId,
      actorUserId: ownerUserId,
      actorKind: "human",
      channel: "rest_ui",
      entity: "document",
      action: "status_changed",
      narrative: "moved the spec to build",
    });

    const result = await purgeStarterSpecsForMemex(memexId);

    expect(result.deleted).toBe(0);
    expect(result.spared[0]).toMatchObject({ docId, reason: "human_activity" });
  });

  it("SPARES a copy the owner commented on, and reports 'commented' (ac-7 / ac-11)", async () => {
    tagAc(AC(7));
    tagAc(AC(11));
    const { memexId, ownerUserId } = await makePersonalMemex("purge-comment");
    const { docId } = await makeSeedShapedCopy(memexId);

    // Comments target exactly one of section/decision/task — use the seeded section.
    const [section] = await db
      .select({ id: docSections.id })
      .from(docSections)
      .where(eq(docSections.docId, docId))
      .limit(1);

    await db.insert(docComments).values({
      memexId,
      docId,
      sectionId: section.id,
      seq: 1,
      authorName: "Owner",
      authorUserId: ownerUserId,
      content: "This bit is useful.",
      channel: "rest_ui",
    });

    const result = await purgeStarterSpecsForMemex(memexId);

    expect(result.deleted).toBe(0);
    expect(result.spared[0]).toMatchObject({ docId, reason: "commented" });
  });

  it("SPARES a copy with a user-attributed version cut, and reports 'user_version' (ac-7 / ac-11)", async () => {
    tagAc(AC(7));
    tagAc(AC(11));
    const { memexId, ownerUserId } = await makePersonalMemex("purge-version");
    const { docId } = await makeSeedShapedCopy(memexId);

    await db.insert(documentVersions).values({
      memexId,
      docId,
      versionNumber: 1,
      name: "Owner snapshot",
      checksum: "deadbeef",
      snapshot: {},
      actorUserId: ownerUserId,
      actorName: "Owner",
      channel: "rest_ui",
    });

    const result = await purgeStarterSpecsForMemex(memexId);

    expect(result.deleted).toBe(0);
    expect(result.spared[0]).toMatchObject({ docId, reason: "user_version" });
  });

  it("SPARES a copy whose version advanced past 1, and reports 'version_advanced' (ac-7)", async () => {
    tagAc(AC(7));
    const { memexId } = await makePersonalMemex("purge-versionadv");
    const { docId } = await makeSeedShapedCopy(memexId);

    await db.update(documents).set({ version: 2 }).where(eq(documents.id, docId));

    const result = await purgeStarterSpecsForMemex(memexId);

    expect(result.deleted).toBe(0);
    expect(result.spared[0]).toMatchObject({ docId, reason: "version_advanced" });
  });

  it("SPARES an archived copy, and reports 'archived' (ac-7)", async () => {
    tagAc(AC(7));
    const { memexId } = await makePersonalMemex("purge-archived");
    const { docId } = await makeSeedShapedCopy(memexId);

    await db.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, docId));

    const result = await purgeStarterSpecsForMemex(memexId);

    expect(result.deleted).toBe(0);
    expect(result.spared[0]).toMatchObject({ docId, reason: "archived" });
  });

  // The identity half of the predicate. A user's own Spec that happens to share the title
  // carries THEIR createdByUserId, so it is not a seeded copy at all — the purge must not
  // even see it. Dropping the NULL-creator clause would delete users' own work.
  it("never touches a user-authored Spec sharing the retired title (ac-8)", async () => {
    tagAc(AC(8));
    const { memexId, ownerUserId } = await makePersonalMemex("purge-lookalike");
    // Same title, but authored BY the user — and otherwise completely pristine, so only
    // the attribution clause can save it.
    const { docId: userOwned } = await makeSeedShapedCopy(memexId, ownerUserId);
    const { docId: seeded } = await makeSeedShapedCopy(memexId);

    const result = await purgeStarterSpecsForMemex(memexId);

    // Only the system-attributed copy was even a candidate.
    expect(result.found).toBe(1);
    expect(result.deleted).toBe(1);
    const survivors = await allSpecsIn(memexId);
    expect(survivors).toContain(userOwned);
    expect(survivors).not.toContain(seeded);
  });

  // The teardown-ordering contract. brief_id is ON DELETE SET NULL, so deleting the doc
  // without clearing its activity rows first would leave orphans that resurface in Pulse
  // as memex-level activity — the spec-474 issue-1 trap. And test_events has NO docId
  // cascade at all, so its rows must be removed explicitly, by ac_uid.
  it("leaves no orphaned activity_log or test_events rows behind (ac-10)", async () => {
    tagAc(AC(10));
    const { memexId, nsSlug } = await makePersonalMemex("purge-orphans");
    const { docId, handle } = await makeSeedShapedCopy(memexId);

    // Give the copy the SYSTEM-attributed activity rows a real seeded copy carries in
    // prod (94 of the 240 have 'document created' / 'section created' / 'ac created' rows
    // with actor_kind='system'). They can't come from createDocDraft here: per std-32 a
    // document's own row IS its activity, so only sourceless events land in activity_log.
    // They must be actor_kind='system' — a non-system row would SPARE the copy and this
    // test would prove nothing about the delete path.
    await db.insert(activityLog).values([
      {
        memexId,
        briefId: docId,
        actorKind: "system",
        channel: "server",
        entity: "document",
        action: "created",
        narrative: "seeded the starter spec",
      },
      {
        memexId,
        briefId: docId,
        actorKind: "system",
        channel: "server",
        entity: "section",
        action: "created",
        narrative: "seeded a narrative section",
      },
    ]);

    const before = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.memexId, memexId), eq(activityLog.briefId, docId)));
    expect(before.length).toBeGreaterThan(0);

    // A synthetic emission against the copy's AC. The real seed emitted none, but the
    // teardown must handle them — this proves step 1 of the ordering actually runs.
    const [ac] = await db
      .select({ seq: acs.seq })
      .from(acs)
      .where(and(eq(acs.memexId, memexId), eq(acs.briefId, docId)))
      .limit(1);
    const acUid = buildAcRef({ namespace: nsSlug, memex: "main", briefHandle: handle }, ac.seq);
    await db.insert(testEvents).values({
      subjectRef: acUid,
      memexId,
      status: "pass",
      testIdentifier: "spec-509 purge orphan guard",
    });

    await purgeStarterSpecsForMemex(memexId);

    // No activity row survived pointing at (or orphaned from) the deleted doc.
    const orphanedActivity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.memexId, memexId), isNull(activityLog.briefId)));
    expect(orphanedActivity).toEqual([]);

    // The emission is gone (it would otherwise survive — no docId FK to cascade through).
    const strandedEvents = await db
      .select({ id: testEvents.id })
      .from(testEvents)
      .where(eq(testEvents.subjectRef, acUid));
    expect(strandedEvents).toEqual([]);
  });

  it("is idempotent — a second run deletes nothing (ac-11)", async () => {
    tagAc(AC(11));
    const { memexId } = await makePersonalMemex("purge-idempotent");
    await makeSeedShapedCopy(memexId);

    const first = await purgeStarterSpecsForMemex(memexId);
    expect(first.deleted).toBe(1);

    const second = await purgeStarterSpecsForMemex(memexId);
    expect(second.found).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.spared).toEqual([]);
  });

  // The safety rail for the prod run: the dry run must be a faithful preview, or reading
  // its output before typing the live command buys nothing.
  it("--dry-run writes nothing and predicts the live run exactly (ac-12)", async () => {
    tagAc(AC(12));
    const { memexId, ownerUserId } = await makePersonalMemex("purge-dryrun");
    const { docId: pristine } = await makeSeedShapedCopy(memexId);
    const { docId: viewed } = await makeSeedShapedCopy(memexId);
    await db.insert(docViews).values({
      userId: ownerUserId,
      docId: viewed,
      lastViewedVersion: 1,
      lastViewedAt: new Date(),
      channel: "rest_ui",
    });

    const dry = await purgeStarterSpecsForMemex(memexId, { dryRun: true });
    expect(dry.found).toBe(2);
    expect(dry.deleted).toBe(1);
    expect(dry.spared).toHaveLength(1);
    // Nothing was written: both copies still exist.
    const stillThere = await seededCopiesIn(memexId);
    expect(stillThere).toHaveLength(2);
    expect(stillThere).toContain(pristine);
    expect(stillThere).toContain(viewed);

    const live = await purgeStarterSpecsForMemex(memexId);
    // The prediction held.
    expect(live.found).toBe(dry.found);
    expect(live.deleted).toBe(dry.deleted);
    expect(live.spared.map((s) => s.docId)).toEqual(dry.spared.map((s) => s.docId));
    expect(await seededCopiesIn(memexId)).toEqual([viewed]);
  });

  // std-39 cl-5: the predicate must be set-based. Several copies in one memex go through
  // ONE evaluation, not one per document.
  it("handles several copies in one memex in a single pass (ac-9)", async () => {
    tagAc(AC(9));
    const { memexId, ownerUserId } = await makePersonalMemex("purge-bulk");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { docId } = await makeSeedShapedCopy(memexId);
      ids.push(docId);
    }
    // One of the five is spared, so the pass has to partition rather than blanket-delete.
    await db.insert(docViews).values({
      userId: ownerUserId,
      docId: ids[2],
      lastViewedVersion: 1,
      lastViewedAt: new Date(),
      channel: "rest_ui",
    });

    const result = await purgeStarterSpecsForMemex(memexId);

    expect(result.found).toBe(5);
    expect(result.deleted).toBe(4);
    expect(result.spared).toHaveLength(1);
    expect(result.spared[0].docId).toBe(ids[2]);
    expect(await seededCopiesIn(memexId)).toEqual([ids[2]]);
  });
});
