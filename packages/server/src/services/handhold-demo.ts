// Handhold onboarding demo — seed / reset / backfill (spec-178 t-2 / t-3 / t-5).
//
// Seeds every personal Memex with five frozen copies of spec-64 ("In-app Memex
// search (⌘K)"), one per phase (draft / specify / build / verify / done), so a new
// user can walk the whole Spec lifecycle on real content. The canonical content
// lives ONCE in db/handhold-demo.fixture.ts; this module maps it through the
// existing service primitives (createDocDraft / addSection / createDecision /
// resolveDecision / createTask / updateTaskStatus / createAc / updateDocStatus —
// each already wraps mutate() + emits, std-8) and flips documents.is_demo=true.
//
// The five demo Specs are EXCLUDED from ⌘K/searchMemex and every agent surface
// (dec-11, which reverses the earlier dec-5/ac-20 "searchable" posture) — that
// exclusion lives in memex-search.ts + the MCP/agent ref-resolvers, NOT here. Their
// per-card AC health shows GREEN at verify/done (dec-9) — so this module does NOT
// touch memex-search or aggregateAcHealthForBriefs; it just writes real rows the
// existing board read paths (REST listDocs/getDoc) already understand. The ONLY
// demo-specific shaping is the is_demo flag (badge + banner, owned by the UI agent)
// and the per-phase value banner (attached by getDoc).

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  namespaces,
  memexes,
  testEvents,
  testEventLatest,
  activityLog,
} from "../db/schema.js";
import { mutate } from "./mutate.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { createTask, updateTaskStatus, type AcceptanceCriterion } from "./tasks.js";
import { createAc, buildAcRef } from "./acs.js";
import { applyEmissionToSummary } from "./test-event-latest.js";
import {
  HANDHOLD_TITLE,
  HANDHOLD_SECTIONS,
  HANDHOLD_DECISIONS,
  HANDHOLD_TASKS,
  HANDHOLD_ACS,
  HANDHOLD_PHASES,
  type HandholdPhaseSlice,
} from "../db/handhold-demo.fixture.js";

// The synthetic emission's test_identifier. A single stable label so reset can
// target it explicitly if ever needed, and so it's recognisable in the matrix
// view as demo-seeded rather than a real CI run.
const HANDHOLD_TEST_IDENTIFIER = "handhold-demo";

// Map the fixture's section keys (other than `overview`, which is the doc purpose
// / first "Overview" section seeded by createDocDraft) to a section_type slug +
// human title for addSection. Kept here, not in the fixture, because it's a
// seed-mechanics concern, not content.
const SECTION_META: Record<
  keyof typeof HANDHOLD_SECTIONS,
  { sectionType: string; title: string }
> = {
  overview: { sectionType: "overview", title: "Overview" },
  scope: { sectionType: "scope", title: "Scope" },
  approach: { sectionType: "approach", title: "Approach" },
  nonGoals: { sectionType: "non-goals", title: "Non-goals" },
  architectureSecurity: {
    sectionType: "architecture-security",
    title: "Architecture & security",
  },
};

// Resolve namespace.slug + memex.slug for a memex so we can build canonical AC
// refs (ac_uid) identically to acs.ts. One round-trip per seed (only used when a
// phase includes ACs).
async function resolveMemexSlugs(
  memexId: string,
): Promise<{ namespace: string; memex: string }> {
  const [row] = await db
    .select({ namespace: namespaces.slug, memex: memexes.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!row) {
    throw new Error(`Memex ${memexId} not found while seeding handhold demo`);
  }
  return row;
}

// Private mirror of test-helpers.ts:seedTestEvent — production code must NOT import
// the test-only helper (per the grounding note). Insert a passing test_events log
// row AND maintain its test_event_latest summary in ONE transaction, so the badge
// read paths (aggregateAcHealthForBriefs / listAcsForBriefWithVerification) see the
// emission as soon as the seed commits. Mirrors the real emission route (spec-162).
async function seedPassingEmission(acUid: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(testEvents)
      .values({
        acUid,
        status: "pass",
        testIdentifier: HANDHOLD_TEST_IDENTIFIER,
        hidden: false,
      })
      .returning({ createdAt: testEvents.createdAt });
    await applyEmissionToSummary(tx, {
      acUid,
      testIdentifier: HANDHOLD_TEST_IDENTIFIER,
      status: "pass",
      latestRunAt: row.createdAt,
      hidden: false,
    });
  });
}

// Build ONE frozen demo Spec for a phase slice. Returns the created doc id.
//
// Order matters:
//   1. createDocDraft (status=draft, "Overview" seeded from HANDHOLD_SECTIONS.overview)
//   2. add the other includeSections via addSection
//   3. if includeDecisions: createDecision → resolveDecision(chosen) for each
//   4. if includeTasks: createTask for each (ACs mapped from .acs, done=tasksComplete);
//      if tasksComplete, updateTaskStatus('complete'). Done WHILE the doc is still
//      'draft' so the build→verify auto-promote (tasks.ts:maybeAutoPromoteToVerify)
//      can't fire and clobber the phase we set in step 6.
//   5. if includeAcs: createAc for each HANDHOLD_ACS (kind 'implementation', active)
//   6. ONE mutate() flips is_demo=true + status=phase + statusChangedAt=now.
//   7. if includeAcs: now that the doc carries its final handle and the ACs have
//      seqs, build each ac_uid and write a passing emission so it reads 'verified'.
async function seedOnePhase(
  memexId: string,
  slice: HandholdPhaseSlice,
  slugs: { namespace: string; memex: string } | null,
): Promise<string> {
  const created = await createDocDraft(
    memexId,
    HANDHOLD_TITLE,
    HANDHOLD_SECTIONS.overview,
    "spec",
    undefined,
    // issue-2: flag is_demo on the SAME insert that creates the row, so the doc is
    // is_demo=true from its first committed state. If the seed is interrupted before
    // the terminal phase-flip below, the leftover is a proper demo doc (excluded from
    // search/agents, badged, removable by Reset), never a search-visible fake real spec.
    { isDemo: true },
  );
  const docId = created.id;

  // Sections beyond `overview` (which createDocDraft already seeded as the first
  // "Overview" section from the purpose argument).
  for (const key of slice.includeSections) {
    if (key === "overview") continue;
    const meta = SECTION_META[key];
    await addSection(memexId, docId, meta.sectionType, HANDHOLD_SECTIONS[key], meta.title);
  }

  if (slice.includeDecisions) {
    for (const dec of HANDHOLD_DECISIONS) {
      const createdDec = await createDecision(memexId, docId, dec.title, dec.context);
      await resolveDecision(memexId, createdDec.id, dec.chosen);
    }
  }

  if (slice.includeTasks) {
    for (const task of HANDHOLD_TASKS) {
      const acceptanceCriteria: AcceptanceCriterion[] = task.acs.map((description) => ({
        description,
        done: slice.tasksComplete,
      }));
      const createdTask = await createTask(
        memexId,
        docId,
        task.title,
        task.body,
        acceptanceCriteria,
      );
      if (slice.tasksComplete) {
        // Safe to complete here: the doc is still 'draft', so updateTaskStatus's
        // build→verify auto-promote (which only fires on a 'build' Spec) is inert.
        await updateTaskStatus(memexId, createdTask.id, "complete");
      }
    }
  }

  const createdAcSeqs: number[] = [];
  if (slice.includeAcs) {
    for (const ac of HANDHOLD_ACS) {
      const createdAc = await createAc({
        memexId,
        briefId: docId,
        kind: ac.kind,
        statement: ac.statement,
      });
      createdAcSeqs.push(createdAc.seq);
    }
  }

  // One terminal write that lands the target phase. is_demo is already true from
  // creation (issue-2), so re-setting it here is idempotent belt-and-suspenders —
  // the load-bearing change is the status flip. Goes through mutate() (std-8) so the
  // document.updated event fires for live UIs.
  await mutate(
    {},
    { memexId, docId, entity: "document", action: "updated" },
    async () => {
      const [row] = await db
        .update(documents)
        .set({ isDemo: true, status: slice.phase, statusChangedAt: new Date() })
        .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)))
        .returning();
      return row;
    },
  );

  // verify / done: each AC reads 'verified' via a synthetic passing emission
  // keyed by its canonical ac_uid (dec-9 / ac-30 / ac-31). Built AFTER the doc is
  // at its phase so the handle + ac seqs that compose the ref already exist.
  if (slice.includeAcs && createdAcSeqs.length > 0) {
    const resolvedSlugs = slugs ?? (await resolveMemexSlugs(memexId));
    for (const seq of createdAcSeqs) {
      const acUid = buildAcRef(
        {
          namespace: resolvedSlugs.namespace,
          memex: resolvedSlugs.memex,
          briefHandle: created.handle,
        },
        seq,
      );
      await seedPassingEmission(acUid);
    }
  }

  return docId;
}

// List the memex's is_demo doc ids. Includes archived/paused — reset/idempotency
// must see EVERY demo doc, not just the active ones.
async function listDemoDocIds(memexId: string): Promise<string[]> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.isDemo, true)));
  return rows.map((r) => r.id);
}

/**
 * Idempotently seed the five frozen demo Specs into `memexId`.
 *
 * NO-OP if the memex already has any is_demo document (the guard makes backfill
 * + reset + repeated calls safe). Builds one frozen copy per HANDHOLD_PHASES
 * entry; sets documents.is_demo=true + the phase status on each.
 */
export async function seedHandholdDemo(memexId: string): Promise<void> {
  const existing = await listDemoDocIds(memexId);
  // Idempotency + self-healing (issue-2): a memex holding the EXACT full set is
  // already seeded → no-op. Any OTHER non-zero count is a NON-canonical leftover —
  // a partial set from an interrupted seed, or a doubled set from a signup×backfill
  // race. The old guard ("any is_demo doc exists → skip") mistook those for "seeded"
  // and left them permanently wedged (a 3-of-5 demo, or a 10-doc double). Clear the
  // leftover (docs + their emissions + activity) and re-seed a clean set, so any
  // partial/doubled state converges to exactly five on the next seed invocation
  // (signup, deploy backfill, or Reset).
  if (existing.length === HANDHOLD_PHASES.length) return;
  if (existing.length > 0) await clearDemoDocs(memexId, existing);

  // Resolve slugs once up-front IFF any phase needs ACs (so we build refs without
  // a per-phase round-trip). Phases without ACs never touch this.
  const anyAcs = HANDHOLD_PHASES.some((p) => p.includeAcs);
  const slugs = anyAcs ? await resolveMemexSlugs(memexId) : null;

  for (const slice of HANDHOLD_PHASES) {
    await seedOnePhase(memexId, slice, slugs);
  }
}

/**
 * Tear down a set of demo docs completely, in the order their tables require:
 *  1. the synthetic AC emissions keyed to them — test_events / test_event_latest
 *     have NO docId cascade (dec-9), so they must be removed explicitly;
 *  2. the activity_log rows that reference them — brief_id is ON DELETE SET NULL,
 *     so leaving them would null brief_id on the hard-delete below and re-surface
 *     seeded demo activity in Pulse as memex-level activity, defeating the ac-21
 *     exclusion (which keys off a live join to the now-deleted doc) (issue-1 / ac-39);
 *  3. the documents themselves — doc_sections / decisions / tasks / acs / doc_comments
 *     cascade via the docId FKs.
 * One mutate() per doc keeps the std-8 'document deleted' emission so live boards
 * refresh. Shared by resetHandholdDemo and seedHandholdDemo's self-heal.
 */
async function clearDemoDocs(memexId: string, demoDocIds: string[]): Promise<void> {
  if (demoDocIds.length === 0) return;

  // Compute the ac_uids for every AC under the demo docs BEFORE deleting the docs
  // (deleting cascades the acs rows away, so we can't resolve seqs after).
  const slugs = await resolveMemexSlugs(memexId);
  const docRows = await db
    .select({ id: documents.id, handle: documents.handle })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), inArray(documents.id, demoDocIds)));
  const handleByDocId = new Map(docRows.map((d) => [d.id, d.handle]));

  const { acs } = await import("../db/schema.js");
  const acRows = await db
    .select({ briefId: acs.briefId, seq: acs.seq })
    .from(acs)
    .where(and(eq(acs.memexId, memexId), inArray(acs.briefId, demoDocIds)));

  const acUids = acRows
    .map((a) => {
      const handle = handleByDocId.get(a.briefId);
      if (!handle) return null;
      return buildAcRef(
        { namespace: slugs.namespace, memex: slugs.memex, briefHandle: handle },
        a.seq,
      );
    })
    .filter((u): u is string => u !== null);

  if (acUids.length > 0) {
    // Delete the log rows AND the derived summary rows so no orphaned emission or
    // stale 'latest' survives (test_events has no docId cascade).
    await db.delete(testEvents).where(inArray(testEvents.acUid, acUids));
    await db.delete(testEventLatest).where(inArray(testEventLatest.acUid, acUids));
  }

  // issue-1 / ac-39: drop the demo docs' activity_log rows BEFORE the hard-delete.
  // brief_id is ON DELETE SET NULL, so leaving them would null brief_id and leak the
  // seeded demo activity into Pulse as memex-level activity. Scoped to this memex.
  await db
    .delete(activityLog)
    .where(and(eq(activityLog.memexId, memexId), inArray(activityLog.briefId, demoDocIds)));

  // Hard-delete the demo documents. One mutate() per doc keeps the std-8 emission
  // contract (a 'document deleted' event each).
  for (const id of demoDocIds) {
    await mutate(
      {},
      { memexId, docId: id, entity: "document", action: "deleted" },
      async () => {
        const [row] = await db
          .delete(documents)
          .where(and(eq(documents.id, id), eq(documents.memexId, memexId)))
          .returning();
        return row;
      },
    );
  }
}

/**
 * Hard-reset the demo in `memexId`: unconditionally tear down every is_demo doc
 * (plus the emissions + activity that reference them — see clearDemoDocs), then
 * re-seed from the fixture.
 *
 * Unlike seedHandholdDemo (which treats a full set as already-seeded), reset always
 * rebuilds — it is the viewer's "discard my edits and restore a pristine demo" button.
 *
 * Returns { seeded } — the count of demo Specs after the re-seed (5).
 */
export async function resetHandholdDemo(memexId: string): Promise<{ seeded: number }> {
  const demoDocIds = await listDemoDocIds(memexId);
  await clearDemoDocs(memexId, demoDocIds);
  // Re-seed from the fixture. seedHandholdDemo now sees zero demo docs.
  await seedHandholdDemo(memexId);
  return { seeded: HANDHOLD_PHASES.length };
}

/**
 * Backfill: seed the demo into every PERSONAL Memex that doesn't already have it.
 *
 * Iterates personal namespaces (namespaces.kind='user') joined to their memexes
 * and calls seedHandholdDemo on each — the per-memex 0-demo guard makes re-runs
 * (e.g. every CI/CD deploy, dec-7) safe and cheap. Returns the count of memexes
 * seeded on THIS run (memexes that already had demo docs are skipped, not counted).
 */
export async function backfillHandholdDemo(): Promise<{ memexesSeeded: number }> {
  const personalMemexes = await db
    .select({ memexId: memexes.id })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(namespaces.kind, "user"));

  let memexesSeeded = 0;
  for (const { memexId } of personalMemexes) {
    const before = await listDemoDocIds(memexId);
    // Call seedHandholdDemo UNCONDITIONALLY (issue-2): it no-ops on a canonical full
    // set and self-heals a partial/doubled set, so the per-deploy backfill doubles as
    // the periodic self-heal trigger. Count only memexes that had ZERO demo docs and
    // got a fresh seed — a heal of a partial set is not a new seed.
    await seedHandholdDemo(memexId);
    if (before.length === 0) memexesSeeded += 1;
  }
  return { memexesSeeded };
}
