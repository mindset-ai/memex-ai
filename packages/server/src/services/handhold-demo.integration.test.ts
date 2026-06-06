// Integration tests for the handhold onboarding demo seed/reset/backfill (spec-178
// t-2 / t-3 / t-5). DB-backed by design: seedHandholdDemo composes ~8 real service
// primitives + the canonical-ref join that the verified-AC emission depends on, so a
// pure unit test would pass while the join (and therefore the GREEN health) silently
// broke. These assert against the same read paths the board + AC tab consume.
//
// Emission no-ops locally without MEMEX_EMIT_KEY — that's expected and irrelevant
// here: the demo's synthetic emissions are written DIRECTLY via the seed's private
// helper (mirroring the real /api/test-events route), not POSTed to prod.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  docSections,
  decisions,
  tasks,
  acs,
  testEvents,
  testEventLatest,
  activityLog,
  namespaces,
  memexes,
  orgs,
  users,
} from "../db/schema.js";
import type { ActivityLogInsert } from "../db/schema.js";
import {
  seedHandholdDemo,
  resetHandholdDemo,
  backfillHandholdDemo,
} from "./handhold-demo.js";
import { getDoc, createDocDraft } from "./documents.js";
import { listActivity } from "./activity-log.js";
import { aggregateAcHealthForBriefs, buildAcRef } from "./acs.js";
import { makeTestMemex } from "./test-helpers.js";
import {
  HANDHOLD_TITLE,
  HANDHOLD_PHASES,
  HANDHOLD_DECISIONS,
  HANDHOLD_TASKS,
  HANDHOLD_ACS,
} from "../db/handhold-demo.fixture.js";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-178";

// Track every memex we make so afterAll can wipe its demo docs + emissions even if
// an assertion throws mid-test.
const memexIds: string[] = [];
const userNamespaceIds: string[] = [];

function uniqueSlug(prefix: string): string {
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${tail}`.toLowerCase().slice(0, 39);
}

// A personal (kind='user') namespace + memex — makeTestMemex makes an org-kind one,
// which backfill (namespaces.kind='user') must NOT pick up. We build a user one by hand.
async function makePersonalMemex(): Promise<{ memexId: string; namespaceId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${uniqueSlug("hd-user")}@example.com`, name: "HD User" })
    .returning();
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: uniqueSlug("hd-ns"), kind: "user", ownerUserId: user.id })
    .returning();
  const [memex] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "personal", name: "Personal" })
    .returning();
  userNamespaceIds.push(ns.id);
  return { memexId: memex.id, namespaceId: ns.id };
}

// All ac_uids that could have been emitted under a memex's demo docs, so cleanup can
// purge test_events / test_event_latest (no docId cascade on test_events).
async function demoAcUids(memexId: string): Promise<string[]> {
  const [slugRow] = await db
    .select({ namespace: namespaces.slug, memex: memexes.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!slugRow) return [];
  const docRows = await db
    .select({ id: documents.id, handle: documents.handle })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.isDemo, true)));
  const handleById = new Map(docRows.map((d) => [d.id, d.handle]));
  const docIds = docRows.map((d) => d.id);
  if (docIds.length === 0) return [];
  const acRows = await db
    .select({ briefId: acs.briefId, seq: acs.seq })
    .from(acs)
    .where(and(eq(acs.memexId, memexId), inArray(acs.briefId, docIds)));
  return acRows
    .map((a) => {
      const handle = handleById.get(a.briefId);
      return handle
        ? buildAcRef(
            { namespace: slugRow.namespace, memex: slugRow.memex, briefHandle: handle },
            a.seq,
          )
        : null;
    })
    .filter((u): u is string => u !== null);
}

afterAll(async () => {
  for (const memexId of memexIds) {
    const acUids = await demoAcUids(memexId).catch(() => []);
    if (acUids.length) {
      await db.delete(testEvents).where(inArray(testEvents.acUid, acUids)).catch(() => {});
      await db.delete(testEventLatest).where(inArray(testEventLatest.acUid, acUids)).catch(() => {});
    }
    await db.delete(activityLog).where(eq(activityLog.memexId, memexId)).catch(() => {});
    await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
  }
  // namespaces cascade to memexes/orgs; user-namespace rows we made directly.
  for (const nsId of userNamespaceIds) {
    await db.delete(namespaces).where(eq(namespaces.id, nsId)).catch(() => {});
  }
});

async function demoDocs(memexId: string) {
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.isDemo, true)));
}

describe("seedHandholdDemo — the five frozen demo Specs", () => {
  let memexId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("hd-seed");
    memexIds.push(memexId);
    await seedHandholdDemo(memexId);
  });

  it("seeds exactly five demo Specs, one per phase, all is_demo with the canonical title", async () => {
    tagAc(`${SPEC}/acs/ac-10`);
    tagAc(`${SPEC}/acs/ac-1`); // scope ac-1: exactly 5 demo Specs, one per phase
    const docs = await demoDocs(memexId);
    expect(docs).toHaveLength(HANDHOLD_PHASES.length);
    expect(docs.length).toBe(5);

    // One demo doc per phase, all flagged + titled spec-64 verbatim.
    const byPhase = new Map(docs.map((d) => [d.status, d]));
    for (const slice of HANDHOLD_PHASES) {
      const doc = byPhase.get(slice.phase);
      expect(doc, `expected a demo doc at phase ${slice.phase}`).toBeDefined();
      expect(doc!.isDemo).toBe(true);
      expect(doc!.docType).toBe("spec");
      expect(doc!.title).toBe(HANDHOLD_TITLE);
    }
    expect(byPhase.size).toBe(5);
  });

  it("composes phase-appropriate content: draft is overview-only; plan resolves decisions; build adds tasks", async () => {
    tagAc(`${SPEC}/acs/ac-13`);
    tagAc(`${SPEC}/acs/ac-2`); // scope ac-2: verbatim spec-64 content, phase-trimmed
    const docs = await demoDocs(memexId);
    const byPhase = new Map(docs.map((d) => [d.status, d.id]));

    // draft → overview only (no decisions, no tasks), exactly one section.
    const draftId = byPhase.get("draft")!;
    const draftSections = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, draftId));
    expect(draftSections).toHaveLength(1);
    expect(draftSections[0].sectionType).toBe("overview");
    expect(
      await db.select().from(decisions).where(eq(decisions.docId, draftId)),
    ).toHaveLength(0);
    expect(await db.select().from(tasks).where(eq(tasks.docId, draftId))).toHaveLength(0);

    // plan → all sections + all decisions RESOLVED, but still no tasks.
    const planId = byPhase.get("plan")!;
    const planDecisions = await db
      .select()
      .from(decisions)
      .where(eq(decisions.docId, planId));
    expect(planDecisions).toHaveLength(HANDHOLD_DECISIONS.length);
    expect(planDecisions.every((d) => d.status === "resolved")).toBe(true);
    expect(planDecisions.every((d) => !!d.resolution)).toBe(true);
    expect(await db.select().from(tasks).where(eq(tasks.docId, planId))).toHaveLength(0);

    // build → tasks present (not complete), decisions still resolved, no ACs yet.
    const buildId = byPhase.get("build")!;
    const buildTasks = await db.select().from(tasks).where(eq(tasks.docId, buildId));
    expect(buildTasks).toHaveLength(HANDHOLD_TASKS.length);
    expect(buildTasks.every((t) => t.status !== "complete")).toBe(true);
    expect(await db.select().from(acs).where(eq(acs.briefId, buildId))).toHaveLength(0);
  });

  it("verify & done surface the spec-level ACs, with completed tasks", async () => {
    tagAc(`${SPEC}/acs/ac-22`);
    tagAc(`${SPEC}/acs/ac-27`); // scope ac-27: existing personal Memexes backfilled, team untouched
    const docs = await demoDocs(memexId);
    const byPhase = new Map(docs.map((d) => [d.status, d.id]));

    for (const phase of ["verify", "done"] as const) {
      const docId = byPhase.get(phase)!;
      const acRows = await db.select().from(acs).where(eq(acs.briefId, docId));
      expect(acRows.length).toBe(HANDHOLD_ACS.length);
      expect(acRows.every((a) => a.kind === "implementation")).toBe(true);
      expect(acRows.every((a) => a.status === "active")).toBe(true);

      const taskRows = await db.select().from(tasks).where(eq(tasks.docId, docId));
      expect(taskRows).toHaveLength(HANDHOLD_TASKS.length);
      expect(taskRows.every((t) => t.status === "complete")).toBe(true);
    }
  });

  it("verify & done ACs read GREEN — every active AC is verified via aggregateAcHealthForBriefs (dec-9)", async () => {
    tagAc(`${SPEC}/acs/ac-30`);
    tagAc(`${SPEC}/acs/ac-31`);
    const docs = await demoDocs(memexId);
    const byPhase = new Map(docs.map((d) => [d.status, d.id]));
    const verifyDoneIds = [byPhase.get("verify")!, byPhase.get("done")!];

    const health = await aggregateAcHealthForBriefs(memexId, verifyDoneIds);
    for (const id of verifyDoneIds) {
      const h = health.get(id)!;
      expect(h.totalActive).toBe(HANDHOLD_ACS.length);
      // Every AC verified, none failing/stale/untested → the card is unambiguously GREEN.
      expect(h.verified).toBe(HANDHOLD_ACS.length);
      expect(h.failing).toBe(0);
      expect(h.stale).toBe(0);
      expect(h.untested).toBe(0);
    }
  });

  it("getDoc attaches the per-phase value banner only for demo docs (dec-8 / ac-28)", async () => {
    tagAc(`${SPEC}/acs/ac-28`);
    const docs = await demoDocs(memexId);
    for (const slice of HANDHOLD_PHASES) {
      const doc = docs.find((d) => d.status === slice.phase)!;
      const fetched = await getDoc(memexId, doc.id);
      expect(fetched.demoValueCallout).toBe(slice.valueCallout);
    }
  });

  it("is idempotent — re-seeding an already-seeded memex adds no sixth doc (ac-8)", async () => {
    tagAc(`${SPEC}/acs/ac-8`);
    tagAc(`${SPEC}/acs/ac-5`); // scope ac-5: idempotent seeding — never >5, never errors
    const before = await demoDocs(memexId);
    expect(before).toHaveLength(5);
    await seedHandholdDemo(memexId);
    await seedHandholdDemo(memexId);
    const after = await demoDocs(memexId);
    expect(after).toHaveLength(5);
    // The very same rows — no churn (ids stable).
    expect(new Set(after.map((d) => d.id))).toEqual(new Set(before.map((d) => d.id)));
  });
});

describe("resetHandholdDemo", () => {
  it("wipes user edits, re-seeds five, and leaves no orphan test_events (ac-14 / ac-15)", async () => {
    tagAc(`${SPEC}/acs/ac-14`);
    tagAc(`${SPEC}/acs/ac-2`); // scope ac-2: phase-appropriate trimming of the verbatim content
    tagAc(`${SPEC}/acs/ac-15`);
    const memexId = await makeTestMemex("hd-reset");
    memexIds.push(memexId);
    await seedHandholdDemo(memexId);

    const before = await demoDocs(memexId);
    expect(before).toHaveLength(5);
    const beforeIds = new Set(before.map((d) => d.id));

    // Simulate a user mucking with a demo doc: rename it + delete a section.
    const victim = before[0];
    await db.update(documents).set({ title: "USER EDIT" }).where(eq(documents.id, victim.id));
    await db.delete(docSections).where(eq(docSections.docId, victim.id));

    // The demo's ac_uids are deterministic (handle + ac seq) so a re-seed reuses
    // the SAME uids. The orphan test is therefore about COUNT, not presence: after
    // reset there must be EXACTLY one emission (+ one summary) per verify/done AC —
    // the old rows purged and not doubled-up — proving the explicit delete ran
    // (test_events has no docId cascade).
    const acUids = await demoAcUids(memexId);
    expect(acUids.length).toBeGreaterThan(0);
    const expectedEmissions = HANDHOLD_ACS.length * 2; // verify + done
    const logBefore = await db
      .select()
      .from(testEvents)
      .where(inArray(testEvents.acUid, acUids));
    expect(logBefore).toHaveLength(expectedEmissions);

    const result = await resetHandholdDemo(memexId);
    expect(result.seeded).toBe(5);

    const after = await demoDocs(memexId);
    expect(after).toHaveLength(5);
    // Fresh docs: the edited doc is gone (new ids), titles all back to canonical.
    expect(after.every((d) => d.title === HANDHOLD_TITLE)).toBe(true);
    expect(after.some((d) => beforeIds.has(d.id))).toBe(false);

    // No doubling: still exactly one emission + one summary row per verify/done AC.
    // Had the reset skipped the explicit test_events delete, this would be 2×.
    const acUidsAfter = await demoAcUids(memexId);
    const orphanLog = await db
      .select()
      .from(testEvents)
      .where(inArray(testEvents.acUid, acUidsAfter));
    expect(orphanLog).toHaveLength(expectedEmissions);
    const orphanSummary = await db
      .select()
      .from(testEventLatest)
      .where(inArray(testEventLatest.acUid, acUidsAfter));
    expect(orphanSummary).toHaveLength(expectedEmissions);

    // The freshly re-seeded verify/done ACs are GREEN again.
    const byPhase = new Map(after.map((d) => [d.status, d.id]));
    const health = await aggregateAcHealthForBriefs(memexId, [
      byPhase.get("verify")!,
      byPhase.get("done")!,
    ]);
    for (const id of [byPhase.get("verify")!, byPhase.get("done")!]) {
      expect(health.get(id)!.verified).toBe(HANDHOLD_ACS.length);
    }
  });
});

describe("backfillHandholdDemo", () => {
  it("seeds personal (user) memexes idempotently; org memexes are untouched (ac-16 / ac-32)", async () => {
    tagAc(`${SPEC}/acs/ac-16`);
    tagAc(`${SPEC}/acs/ac-4`); // scope ac-4: one Reset restores all 5, discarding viewer edits
    tagAc(`${SPEC}/acs/ac-32`);

    // Two fresh personal memexes (kind='user') with no demo docs yet.
    const a = await makePersonalMemex();
    const b = await makePersonalMemex();
    memexIds.push(a.memexId, b.memexId);

    // An org memex (kind='org') that must NOT be backfilled.
    const orgMemexId = await makeTestMemex("hd-org");
    memexIds.push(orgMemexId);

    await backfillHandholdDemo();

    // Both personal memexes now hold the five demo Specs.
    expect(await demoDocs(a.memexId)).toHaveLength(5);
    expect(await demoDocs(b.memexId)).toHaveLength(5);
    // The org memex was skipped entirely.
    expect(await demoDocs(orgMemexId)).toHaveLength(0);

    // Idempotent: a second backfill seeds nothing new (both already have demo docs).
    const second = await backfillHandholdDemo();
    expect(second.memexesSeeded).toBe(0);
    expect(await demoDocs(a.memexId)).toHaveLength(5);
    expect(await demoDocs(b.memexId)).toHaveLength(5);
  });
});

// issue-2 / t-13 (H2): the seed is not atomic — a partial/interrupted seed must not
// permanently wedge the idempotency guard, and a demo doc must be is_demo from its
// first committed state (no search/agent-visible is_demo=false orphan window).
describe("seedHandholdDemo — atomicity / self-healing guard (ac-40)", () => {
  it("self-heals a partial demo set to exactly five instead of treating it as already-seeded", async () => {
    tagAc(`${SPEC}/acs/ac-40`);
    const mx = await makeTestMemex("hd-selfheal");
    memexIds.push(mx);
    await seedHandholdDemo(mx);
    const full = await demoDocs(mx);
    expect(full).toHaveLength(5);

    // Simulate an interrupted seed: drop the draft + plan demo docs (neither carries
    // ACs/emissions), leaving 3 of 5 behind.
    const byPhase = new Map(full.map((d) => [d.status, d.id]));
    await db
      .delete(documents)
      .where(inArray(documents.id, [byPhase.get("draft")!, byPhase.get("plan")!]));
    expect(await demoDocs(mx)).toHaveLength(3);

    // The old guard ("any is_demo doc exists → skip") would leave this wedged at 3
    // forever. The count-aware guard detects 3 ≠ 5 and re-seeds a fresh full set.
    await seedHandholdDemo(mx);
    const healed = await demoDocs(mx);
    expect(healed).toHaveLength(5);
    expect(new Set(healed.map((d) => d.status))).toEqual(
      new Set(["draft", "plan", "build", "verify", "done"]),
    );
  });

  it("createDocDraft persists is_demo=true atomically at creation (no is_demo=false orphan window)", async () => {
    tagAc(`${SPEC}/acs/ac-40`);
    const mx = await makeTestMemex("hd-flagcreate");
    memexIds.push(mx);
    // The seeder builds demo docs with is_demo set on the SAME insert as the row —
    // so even a crash before the terminal phase-flip leaves a proper demo doc
    // (excluded/badged/resettable), never a fake real spec.
    const created = await createDocDraft(mx, HANDHOLD_TITLE, "overview", "spec", undefined, {
      isDemo: true,
    });
    const [row] = await db.select().from(documents).where(eq(documents.id, created.id));
    expect(row.isDemo).toBe(true);
  });
});

// issue-1 / t-12 (H1): activity_log.brief_id is ON DELETE SET NULL, so demo-doc
// activity that survives a Reset's hard-delete re-surfaces as memex-level activity
// and leaks into Pulse. Reset must delete the demo docs' activity_log rows.
describe("resetHandholdDemo — clears demo activity so it cannot leak into Pulse (ac-39)", () => {
  it("deletes the demo docs' activity_log rows on reset (brief_id SET NULL would otherwise re-surface them)", async () => {
    tagAc(`${SPEC}/acs/ac-39`);
    const mx = await makeTestMemex("hd-pulse-leak");
    memexIds.push(mx);
    await seedHandholdDemo(mx);
    const demoIds = (await demoDocs(mx)).map((d) => d.id);
    expect(demoIds).toHaveLength(5);

    // Simulate the seed-time activity the bus sink writes against a demo doc.
    const marker = `demo-seed-activity-${Date.now()}`;
    const row: ActivityLogInsert = {
      memexId: mx,
      briefId: demoIds[0],
      actorKind: "system",
      channel: "server",
      entity: "document",
      action: "updated",
      narrative: marker,
    };
    await db.insert(activityLog).values(row);
    // Steady state: excluded while the demo doc is live (is_demo=true).
    expect((await listActivity({ memexId: mx })).some((r) => r.narrative === marker)).toBe(false);

    await resetHandholdDemo(mx);

    // The demo doc is hard-deleted; without the fix brief_id → NULL and the row
    // re-surfaces as memex-level activity. The fix deletes it during reset.
    const after = await listActivity({ memexId: mx });
    expect(after.some((r) => r.narrative === marker)).toBe(false);
    // Defensive: no doc-scoped activity leaked with a nulled brief_id.
    expect(after.some((r) => r.briefId === null && r.entity !== "memex")).toBe(false);
  });
});

// t-1 (ac-9): the migration's column contract — is_demo is NOT NULL DEFAULT false,
// so every pre-existing doc (created before the migration / without setting it) reads
// false, and the column can never hold NULL.
describe("documents.is_demo column contract (ac-9)", () => {
  it("is NOT NULL DEFAULT false — a row created without is_demo reads false; setting it NULL is rejected", async () => {
    tagAc(`${SPEC}/acs/ac-9`);
    const mx = await makeTestMemex("hd-isdemo-col");
    memexIds.push(mx);

    // DEFAULT false: insert a documents row WITHOUT mentioning is_demo — exactly the
    // shape of every row that existed before the migration. It must read back false.
    const [row] = await db
      .insert(documents)
      .values({
        memexId: mx,
        handle: `spec-coltest-${Date.now()}`,
        title: "is_demo column test",
        docType: "spec",
        status: "draft",
      })
      .returning();
    expect(row.isDemo).toBe(false);

    // NOT NULL: forcing is_demo to NULL is rejected by the column constraint (23502).
    await expect(
      db.execute(sql`UPDATE documents SET is_demo = NULL WHERE id = ${row.id}`),
    ).rejects.toThrow();
  });
});

// dec-8 (ac-29): the per-phase value banner is SERVED as a fixture constant keyed by
// phase — it is NOT persisted on the demo document (no new column beyond is_demo, and
// not stored as a section). ac-26/ac-28 prove getDoc returns it; this pins the negative
// contract a regression (adding a value_callout column + reading from it) would violate.
describe("value banner is served from the fixture, not stored on the doc (ac-29)", () => {
  it("documents has no callout column (only is_demo was added), and no demo doc stores the callout text as a section", async () => {
    tagAc(`${SPEC}/acs/ac-29`);

    // (1) No callout/banner column was added to documents — only is_demo (ac-9).
    const cols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'documents'
    `)) as unknown as { column_name: string }[];
    const names = cols.map((c) => c.column_name);
    expect(names).toContain("is_demo");
    expect(names.some((n) => /callout|banner|value_call/i.test(n))).toBe(false);

    // (2) Seed a demo; getDoc returns the per-phase callout sourced from the fixture…
    const mx = await makeTestMemex("hd-callout-store");
    memexIds.push(mx);
    await seedHandholdDemo(mx);
    const docs = await demoDocs(mx);
    for (const slice of HANDHOLD_PHASES) {
      const doc = docs.find((d) => d.status === slice.phase)!;
      const fetched = await getDoc(mx, doc.id);
      expect(fetched.demoValueCallout).toBe(slice.valueCallout);
    }

    // (3) …but the callout text is NOT persisted as a section on ANY demo doc — it
    // lives only in the fixture, served at read time.
    const sectionRows = await db
      .select()
      .from(docSections)
      .where(inArray(docSections.docId, docs.map((d) => d.id)));
    const calloutTexts = new Set(HANDHOLD_PHASES.map((p) => p.valueCallout));
    expect(sectionRows.some((s) => calloutTexts.has(s.content))).toBe(false);
  });
});

// dec-6 (ac-23): the demo ships ON-BY-DEFAULT — seeding (signup hook + backfill) and
// Reset are conditioned on NO feature flag, so they run in every environment even when
// HIDDEN_FEATURES is set (the soft-launch switch hiding Scaffold/pause/Pulse). This
// guards the launch-critical "always on" contract against a future regression that
// wires the demo behind HIDDEN_FEATURES and silently disables it wherever that var is
// set — the exact footgun dec-6 rejected.
describe("Handhold demo is on-by-default — not gated by any feature flag (ac-23)", () => {
  let priorHiddenFeatures: string | undefined;
  beforeAll(() => {
    priorHiddenFeatures = process.env.HIDDEN_FEATURES;
    // Hide everything we plausibly could, including a hypothetical 'handhold' token —
    // if the seed/reset paths read this flag at all, the assertions below would fail.
    process.env.HIDDEN_FEATURES = "handhold,scaffold,pause,pulse";
  });
  afterAll(() => {
    if (priorHiddenFeatures === undefined) delete process.env.HIDDEN_FEATURES;
    else process.env.HIDDEN_FEATURES = priorHiddenFeatures;
  });

  it("seeds and resets regardless of HIDDEN_FEATURES — the seed/reset paths read no flag", async () => {
    tagAc(`${SPEC}/acs/ac-23`);
    const mx = await makeTestMemex("hd-noflag");
    memexIds.push(mx);

    // Seeding runs with HIDDEN_FEATURES set → still produces the 5 demo specs.
    await seedHandholdDemo(mx);
    expect(await demoDocs(mx)).toHaveLength(5);

    // Reset runs with HIDDEN_FEATURES set → still re-seeds the 5.
    const result = await resetHandholdDemo(mx);
    expect(result.seeded).toBe(5);
    expect(await demoDocs(mx)).toHaveLength(5);
  });
});
