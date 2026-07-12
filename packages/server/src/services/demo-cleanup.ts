// Demo-doc teardown (spec-474) — the residual half of the retired handhold demo.
//
// The demo SEED/reveal/reset code (spec-178's seedHandholdDemo et al.) was deleted
// when the demo-vs-starter experiment concluded with the starter Spec as the winner
// (spec-474 dec-1). What survives is the ability to TEAR DOWN any is_demo docs a
// personal Memex still carries from before the cutover — the migration/cleanup path
// and the e2e arm-reset defensive clear both need it. No seeder lives here.

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
import { mutate, type RequestCtx } from "./mutate.js";
import { buildAcRef } from "./acs.js";

// Resolve namespace.slug + memex.slug for a memex so we can build canonical AC
// refs (ac_uid) identically to acs.ts. One round-trip per teardown (only used when
// the demo docs carry ACs whose synthetic emissions must be removed).
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
    throw new Error(`Memex ${memexId} not found while clearing demo docs`);
  }
  return row;
}

// List the memex's is_demo doc ids. Includes archived/paused — teardown/idempotency
// must see EVERY demo doc, not just the active ones.
async function listDemoDocIds(memexId: string): Promise<string[]> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.isDemo, true)));
  return rows.map((r) => r.id);
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
 * refresh. The ctx carries the channel (HOW) onto each delete so the teardown is
 * attributed in the activity contract (std-32) rather than landing channel-less.
 */
async function clearDemoDocs(
  memexId: string,
  demoDocIds: string[],
  ctx: RequestCtx = { channel: "server" },
): Promise<void> {
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
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, acUids));
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, acUids));
  }

  // issue-1 / ac-39: drop the demo docs' activity_log rows BEFORE the hard-delete.
  // brief_id is ON DELETE SET NULL, so leaving them would null brief_id and leak the
  // seeded demo activity into Pulse as memex-level activity. Scoped to this memex.
  await db
    .delete(activityLog)
    .where(and(eq(activityLog.memexId, memexId), inArray(activityLog.briefId, demoDocIds)));

  // Hard-delete the demo documents. One mutate() per doc keeps the std-8 emission
  // contract (a 'document deleted' event each), threading the caller's ctx so the
  // delete carries a real channel (std-32).
  for (const id of demoDocIds) {
    await mutate(
      ctx,
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
 * Tear down EVERY is_demo doc in `memexId` (plus the emissions + activity that
 * reference them — see clearDemoDocs) WITHOUT re-seeding. Exposed for callers that
 * need the memex demo-free — e.g. the spec-426/spec-474 experiment-arm test seed,
 * which must wipe any demo docs a pre-cutover signup left behind before seeding the
 * starter spec. NO-OP when the memex carries no demo docs.
 */
export async function clearDemoDocsForMemex(
  memexId: string,
  ctx: RequestCtx = { channel: "server" },
): Promise<void> {
  const demoDocIds = await listDemoDocIds(memexId);
  await clearDemoDocs(memexId, demoDocIds, ctx);
}
