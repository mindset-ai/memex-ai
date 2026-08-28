// Service layer for Acceptance Criteria (feat-ac-spike V0.0.1).
//
// An AC is a forward-facing testable assertion. Two flavours, same shape:
//   'scope'          — manager-authored, plain-English outcome commitment;
//                       direct parent is typically the Spec itself.
//   'implementation' — agent-spawned from a resolved Decision; technical;
//                       direct parent is typically one or more Decisions.
//
// Tenancy is via acs.brief_id (NOT NULL). Direct parentage is via
// ac_parent_links — separate from tenancy because blast-radius cascades
// follow direct parentage, not the tenancy column. See
// docs/ac-primitive-hypothesis.md for the full thesis.
//
// V0.0.1 surface:
//   createAc           — author an AC under a Spec, optionally linked to one parent
//   listAcsForBrief    — list ACs for a Spec, optionally filtered by kind/status
//   getAc              — fetch one AC by id
//   updateAc           — mutate AC statement (kind and status are NOT editable here)
//   deleteAc           — hard delete (FKs cascade ac_parent_links + task_satisfies_ac)
//   acceptAc           — transition proposed → active (the agent-flagged-for-review case)
//   rejectAc           — transition any state → rejected
//   linkAcToParent     — add a parent link (parent_kind + parent_id)
//   unlinkAcFromParent — remove a parent link

import { and, eq, asc, desc, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  acs,
  acParentLinks,
  decisions,
  documents,
  memexes,
  namespaces,
  testEvents,
  testEventLatest,
} from "../db/schema.js";
import type { InferSelectModel } from "drizzle-orm";
import { ConflictError, NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";
import { removeSummaryForPair } from "./test-event-latest.js";
import { nextSeq, withSeqRetry } from "./shared/sequence.js";

export type Ac = InferSelectModel<typeof acs>;
export type AcParentLink = InferSelectModel<typeof acParentLinks>;

export type AcKind = "scope" | "implementation";
export type AcStatus = "proposed" | "active" | "rejected" | "superseded";
// The parent-kind discriminator is a DB-level value, NOT the product noun.
// The `ac_parent_links` CHECK constraint is `parent_kind IN ('brief','decision')`
// (schema.ts). Renaming this value to 'spec' requires a separate Drizzle
// migration + row backfill and is out of scope for b-105 — same posture as the
// `kind: "brief"` discriminator on comments (see services/comments.ts). The
// product noun is "Spec"; this literal stays "brief" so existing rows + the
// CHECK keep working. Allowlisted in .legacy-spec-vocab-allowlist.txt.
export type ParentKind = "brief" | "decision";

// Verifies the doc exists in the memex; throws NotFoundError otherwise. Mirrors the
// guard pattern in services/decisions.ts:assertDocInAccount.
async function assertBriefInMemex(memexId: string, briefId: string): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, briefId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Spec ${briefId} not found in memex ${memexId}`);
  }
}

export interface CreateAcInput {
  memexId: string;
  briefId: string;
  kind: AcKind;
  statement: string;
  status?: AcStatus;
  // Optional parent link to create alongside the AC. If omitted for a Scope AC,
  // the caller should typically link parent_kind='brief' so blast-radius
  // cascades work. If omitted for an Implementation AC, the AC has no parent
  // Decision (rare but allowed: defaults, mid-build discoveries, imports).
  parent?: { kind: ParentKind; id: string };
}

export async function createAc(
  input: CreateAcInput,
  ctx: RequestCtx = {},
): Promise<Mutated<Ac>> {
  const { memexId, briefId, kind, statement, status = "active", parent } = input;
  if (!statement.trim()) {
    throw new ValidationError("AC statement is required");
  }
  await assertBriefInMemex(memexId, briefId);

  // Allocate seq + insert under withSeqRetry, mirroring createDecision (b-38 F-3).
  // Concurrent creates under the same Spec shouldn't 23505 on the unique constraint.
  const result = await mutate(
    ctx,
    { memexId, docId: briefId, entity: "ac", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(acs, acs.seq, acs.briefId, briefId);
          const [row] = await db
            .insert(acs)
            // spec-122 dec-2/dec-5 — stamp WHO + HOW at write time (ac-20).
            .values({ memexId, briefId, seq, kind, statement, status, ...(await resolveActorColumns(ctx)) })
            .returning();
          if (parent) {
            await db.insert(acParentLinks).values({
              acId: row.id,
              parentKind: parent.kind,
              parentId: parent.id,
            });
          }
          return row;
        },
        "acs_brief_id_seq_unique",
      ),
  );
  return result;
}

export interface ListAcsFilter {
  kind?: AcKind;
  status?: AcStatus;
}

export async function listAcsForBrief(
  memexId: string,
  briefId: string,
  filter: ListAcsFilter = {},
): Promise<Ac[]> {
  await assertBriefInMemex(memexId, briefId);
  const conditions = [eq(acs.memexId, memexId), eq(acs.briefId, briefId)];
  if (filter.kind) conditions.push(eq(acs.kind, filter.kind));
  if (filter.status) conditions.push(eq(acs.status, filter.status));
  // spec-448 (gap closure, ac-18): exclude ACs a version cut left behind
  // (retired_at_version stamped) from the live read — they still render when
  // viewing the version they were retired at (getVersionSnapshot).
  conditions.push(isNull(acs.retiredAtVersion));
  return db.query.acs.findMany({
    where: and(...conditions),
    orderBy: [asc(acs.seq)],
  });
}

export async function getAc(memexId: string, acId: string): Promise<Ac> {
  const row = await db.query.acs.findFirst({
    where: and(eq(acs.id, acId), eq(acs.memexId, memexId)),
  });
  if (!row) {
    throw new NotFoundError(`AC ${acId} not found in memex ${memexId}`);
  }
  return row;
}

async function transitionStatus(
  memexId: string,
  acId: string,
  from: AcStatus[],
  to: AcStatus,
): Promise<Mutated<Ac>> {
  const ac = await getAc(memexId, acId);
  if (!from.includes(ac.status as AcStatus)) {
    throw new ConflictError(
      `AC ${acId} is ${ac.status}; cannot transition to ${to} (expected one of ${from.join(", ")})`,
    );
  }
  return mutate(
    {},
    { memexId, docId: ac.briefId, entity: "ac", action: "updated" },
    async () => {
      const [row] = await db
        .update(acs)
        .set({ status: to, updatedAt: new Date() })
        .where(and(eq(acs.id, acId), eq(acs.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

export async function updateAc(
  memexId: string,
  acId: string,
  statement: string,
  ctx: RequestCtx = {},
): Promise<Mutated<Ac>> {
  if (!statement.trim()) {
    throw new ValidationError("AC statement is required");
  }
  const ac = await getAc(memexId, acId); // tenancy check
  return mutate(
    ctx,
    { memexId, docId: ac.briefId, entity: "ac", action: "updated" },
    async () => {
      const [row] = await db
        .update(acs)
        // spec-122 dec-2/dec-5 — re-attribute on edit (who touched it last).
        .set({ statement, updatedAt: new Date(), ...(await resolveActorColumns(ctx)) })
        .where(and(eq(acs.id, acId), eq(acs.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

export async function deleteAc(memexId: string, acId: string): Promise<Mutated<Ac>> {
  const ac = await getAc(memexId, acId); // tenancy check + capture row for return
  return mutate(
    {},
    { memexId, docId: ac.briefId, entity: "ac", action: "deleted" },
    async () => {
      // FKs cascade: ac_parent_links + task_satisfies_ac rows for this AC
      // are dropped automatically.
      await db.delete(acs).where(and(eq(acs.id, acId), eq(acs.memexId, memexId)));
      return ac;
    },
  );
}

export async function acceptAc(memexId: string, acId: string): Promise<Mutated<Ac>> {
  return transitionStatus(memexId, acId, ["proposed"], "active");
}

export async function rejectAc(memexId: string, acId: string): Promise<Mutated<Ac>> {
  return transitionStatus(memexId, acId, ["proposed", "active"], "rejected");
}

export async function linkAcToParent(
  memexId: string,
  acId: string,
  parent: { kind: ParentKind; id: string },
): Promise<Mutated<AcParentLink>> {
  const ac = await getAc(memexId, acId); // tenancy check
  return mutate(
    {},
    { memexId, docId: ac.briefId, entity: "ac_parent_link", action: "created" },
    async () => {
      const [row] = await db
        .insert(acParentLinks)
        .values({ acId, parentKind: parent.kind, parentId: parent.id })
        .onConflictDoNothing()
        .returning();
      // If the row already existed, the returning is empty; fetch and return it.
      if (row) return row;
      const existing = await db.query.acParentLinks.findFirst({
        where: and(
          eq(acParentLinks.acId, acId),
          eq(acParentLinks.parentKind, parent.kind),
          eq(acParentLinks.parentId, parent.id),
        ),
      });
      if (!existing) {
        throw new Error(`Failed to create or find ac_parent_link for ac ${acId}`);
      }
      return existing;
    },
  );
}

export async function unlinkAcFromParent(
  memexId: string,
  acId: string,
  parent: { kind: ParentKind; id: string },
): Promise<Mutated<void>> {
  const ac = await getAc(memexId, acId);
  return mutate(
    {},
    { memexId, docId: ac.briefId, entity: "ac_parent_link", action: "deleted" },
    async () => {
      await db
        .delete(acParentLinks)
        .where(
          and(
            eq(acParentLinks.acId, acId),
            eq(acParentLinks.parentKind, parent.kind),
            eq(acParentLinks.parentId, parent.id),
          ),
        );
    },
  );
}

export async function listParentLinks(acId: string): Promise<AcParentLink[]> {
  return db.query.acParentLinks.findMany({
    where: eq(acParentLinks.acId, acId),
  });
}

// ══════════════════════════════════════════════════════════════════════
// Verification view — joins acs ↔ test_events for the AC tab
// ══════════════════════════════════════════════════════════════════════
//
// Two queries, joined in memory by subject_ref. We could fold them into one big
// SQL with window functions but readability matters more than the round-trip
// here: the tab is a low-traffic surface, and the two-step shape makes the
// derivation rules (verified/failing/untested/stale) sit in TypeScript where
// they're testable rather than buried in a CTE.
//
// `subject_ref` per the emission contract (docs/ac-primitive-hypothesis.md and
// guidance/ac-emission.json) is the FULL canonical ref, not the bare handle:
//   <namespace>/<memex>/specs/<spec-handle>/acs/ac-<seq>
// We rebuild that string per AC and use it to match test_events.subject_ref.

/**
 * Days after which a verified AC's last test event makes it "stale" — the
 * code may still be doing the right thing, but the proof is out of date.
 * Documented as configurable later; hardcoded for V0.0.1. The number is
 * deliberately not committee-engineered — see the merge-request thread on
 * MR !20 follow-up: "I don't fucking know. Just go for seven." Adjusting
 * this is expected; it's one constant.
 */
export const STALE_THRESHOLD_DAYS = 7;

// spec-188 dec-1: 'accepted' is a first-class fifth state — the audited human
// override for ACs that can't be exercised by a digital test. It counts toward
// the verified percentage in the UI but keeps its own visual identity.
export type VerificationState =
  | "verified"
  | "failing"
  | "untested"
  | "stale"
  | "accepted";

export interface AcTestSnapshot {
  /** file::function or whatever the emitting test passed as test_identifier. */
  testIdentifier: string | null;
  /** Latest emission for this (subject_ref, test_identifier). */
  latestStatus: "pass" | "fail" | "error";
  latestRunAt: Date;
  /** Total emissions ever for this (subject_ref, test_identifier). */
  runCount: number;
}

export interface AcWithVerification {
  ac: Ac;
  canonicalRef: string;
  tests: AcTestSnapshot[];
  verificationState: VerificationState;
  /** null when the AC has no test events ever (untested). */
  daysSinceLastRun: number | null;
  /**
   * Polymorphic parent links — exactly mirrors `ac_parent_links` rows for this
   * AC. Implementation ACs typically have one decision parent; Scope ACs
   * typically have the spec itself as parent. The Decisions tab uses this
   * to render a coverage strip per resolved Decision (i.e. "filter ACs whose
   * parents include {kind:'decision', id:dec.id}").
   *
   * Empty array means the AC has no recorded parent — valid for V0.0.1 (the
   * service layer doesn't currently enforce a parent on create).
   */
  parents: Array<{ kind: ParentKind; id: string }>;
}

interface BriefSlugs {
  namespace: string;
  memex: string;
  briefHandle: string;
}

async function resolveBriefSlugsForRef(briefId: string): Promise<BriefSlugs> {
  // The canonical ref uses the namespace + memex + spec HANDLE. The handle
  // (`spec-N` for Specs) lives on documents.handle. We pull all three in a
  // single join so the snapshot query doesn't need to hop the DB four times.
  const [row] = await db
    .select({
      namespace: namespaces.slug,
      memex: memexes.slug,
      briefHandle: documents.handle,
    })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(documents.id, briefId))
    .limit(1);
  if (!row || !row.briefHandle) {
    throw new NotFoundError(`Spec ${briefId} not found or has no handle`);
  }
  return {
    namespace: row.namespace,
    memex: row.memex,
    briefHandle: row.briefHandle,
  };
}

// Exported so the per-Spec aggregator (aggregateAcHealthForBriefs, b-66 t-2)
// can construct canonical refs identically to listAcsForBriefWithVerification.
// The board's health roll-up MUST share this builder — a hand-built ref that
// diverges by even a separator would silently break the test_events join and
// the card colour would lie relative to the AC tab.
export function buildAcRef(slugs: BriefSlugs, acSeq: number): string {
  return `${slugs.namespace}/${slugs.memex}/specs/${slugs.briefHandle}/acs/ac-${acSeq}`;
}

// Exported so the per-Spec aggregator (aggregateAcHealthForBriefs, b-66 t-2)
// derives state through the same helper as the AC tab. Card state can never
// disagree with tab state for the same AC — this is b-66 Scope AC-3 in code.
export function deriveVerificationState(
  tests: AcTestSnapshot[],
  daysSinceLastRun: number | null,
  // spec-188 dec-2: true when the AC carries a manual acceptance (accepted_at
  // set). Evidence wins — failing/erroring tests suppress the acceptance —
  // but absent contradicting evidence the acceptance presents, including over
  // verified/stale (passing tests "return" the AC to accepted, per dec-2).
  accepted = false,
): VerificationState {
  // ANY failing/erroring test wins — a partial pass is not verified, and
  // failing evidence suppresses a manual acceptance (spec-188 dec-2).
  const anyFailed = tests.some(
    (t) => t.latestStatus === "fail" || t.latestStatus === "error",
  );
  if (anyFailed) return "failing";
  if (accepted) return "accepted";
  if (tests.length === 0) return "untested";
  if (daysSinceLastRun !== null && daysSinceLastRun > STALE_THRESHOLD_DAYS) {
    return "stale";
  }
  return "verified";
}

/**
 * Snapshot query for the AC tab: returns every AC for a Spec alongside its
 * latest test events and a derived verification_state.
 *
 * Ordering: by kind then seq, so the UI gets scope ACs before implementation
 * ACs and stable ordering within each kind. The kind split happens in the
 * caller (UI groups by `ac.kind`).
 */
export async function listAcsForBriefWithVerification(
  memexId: string,
  briefId: string,
): Promise<AcWithVerification[]> {
  await assertBriefInMemex(memexId, briefId);
  const slugs = await resolveBriefSlugsForRef(briefId);

  // spec-448 (gap closure, ac-18): exclude ACs a version cut left behind
  // (retired_at_version stamped) from the live AC-tab read — they still
  // render when viewing the version they were retired at (getVersionSnapshot).
  const acRows = await db.query.acs.findMany({
    where: and(eq(acs.memexId, memexId), eq(acs.briefId, briefId), isNull(acs.retiredAtVersion)),
    orderBy: [asc(acs.kind), asc(acs.seq)],
  });
  if (acRows.length === 0) return [];

  // Build the universe of subject_refs we care about, in one round-trip.
  const refByAcId = new Map(acRows.map((a) => [a.id, buildAcRef(slugs, a.seq)]));
  const allRefs = Array.from(refByAcId.values());

  // spec-162: read the latest-per-(subject_ref, test_identifier) summary directly
  // instead of scanning the whole test_events history. One row per pair already,
  // so there's no latest-wins reduction to do in JS — the summary table did it,
  // making this O(active AC×test pairs), not O(history). Hidden events never
  // enter test_event_latest (the upsert skips them), so no hidden filter is
  // needed; test_identifier is stored as '' for the null case (dec-2).
  const summaryRows = await db
    .select({
      subjectRef: testEventLatest.subjectRef,
      testIdentifier: testEventLatest.testIdentifier,
      latestStatus: testEventLatest.latestStatus,
      latestRunAt: testEventLatest.latestRunAt,
      runCount: testEventLatest.runCount,
    })
    .from(testEventLatest)
    // spec-520 t-4 (ac-11): ONE bind parameter for the whole ref list.
    //
    // `IN (…)` binds one parameter PER REF, and each distinct COUNT is its own prepared
    // statement, plan-cache entry and pg_stat_statements row. That fragmentation is what
    // put 1,223 fingerprints — ~24.5% of the instance's 5,000 cap, which is 98.6% full and
    // already evicting — behind one logical read (issue-10).
    //
    // `= ANY($1::text[])` is one parameter however many refs there are, so ONE fingerprint.
    // Deliberately NOT rewritten to `memex_id = $1` alone like aggregateAcHealthForBriefs:
    // that read already touched every row of the tenant, so scoping it tenant-wide cost
    // nothing. This one serves a SINGLE Spec — tens of refs — and a tenant-wide read would
    // fetch ~148k rows for the largest Memex to filter down to a handful.
    //
    // memex_id is added alongside so tenancy is an explicit predicate rather than an
    // inference from ref-string uniqueness — the spec-396 posture, and what makes the
    // (memex_id, subject_ref) index usable here.
    .where(
      and(
        eq(testEventLatest.memexId, memexId),
        // sql.param() is load-bearing: a bare `${allRefs}` makes drizzle interpolate the
        // array as a LIST of parameters — the very fragmentation this is removing, and it
        // fails outright against `= ANY(…)`. sql.param binds it as ONE array parameter.
        sql`${testEventLatest.subjectRef} = ANY(${sql.param(allRefs)}::text[])`,
      ),
    );

  // Pull every parent link for our AC set in one query. The Decisions tab
  // uses these to find "the ACs hanging off this resolved decision" without
  // making the React layer fetch per-decision.
  const acIds = acRows.map((a) => a.id);
  const parentLinks = await db.query.acParentLinks.findMany({
    where: inArray(acParentLinks.acId, acIds),
  });
  const parentsByAcId = new Map<
    string,
    Array<{ kind: ParentKind; id: string }>
  >();
  for (const link of parentLinks) {
    const list = parentsByAcId.get(link.acId) ?? [];
    list.push({
      kind: link.parentKind as ParentKind,
      id: link.parentId,
    });
    parentsByAcId.set(link.acId, list);
  }

  // Bucket the summary rows per subject_ref. One row per (subject_ref, test_identifier)
  // pair already, so this is a straight push — no latest-wins reduction. '' maps
  // back to null to preserve the AcTestSnapshot shape the prior reduce produced.
  const testsByRef = new Map<string, AcTestSnapshot[]>();
  for (const row of summaryRows) {
    const list = testsByRef.get(row.subjectRef) ?? [];
    list.push({
      testIdentifier: row.testIdentifier === "" ? null : row.testIdentifier,
      latestStatus: row.latestStatus as "pass" | "fail" | "error",
      latestRunAt: row.latestRunAt,
      runCount: row.runCount,
    });
    testsByRef.set(row.subjectRef, list);
  }

  const now = Date.now();
  return acRows.map((ac) => {
    const ref = refByAcId.get(ac.id)!;
    const tests = testsByRef.get(ref) ?? [];
    const latestRunAt = tests.reduce<Date | null>(
      (acc, t) =>
        acc === null || t.latestRunAt > acc ? t.latestRunAt : acc,
      null,
    );
    const daysSinceLastRun =
      latestRunAt === null
        ? null
        : Math.floor((now - latestRunAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      ac,
      canonicalRef: ref,
      tests,
      verificationState: deriveVerificationState(
        tests,
        daysSinceLastRun,
        ac.acceptedAt !== null,
      ),
      daysSinceLastRun,
      parents: parentsByAcId.get(ac.id) ?? [],
    };
  });
}

// ══════════════════════════════════════════════════════════════════════
// Manual verification acceptance (spec-188 dec-1/dec-2)
// ══════════════════════════════════════════════════════════════════════
//
// The audited human override for ACs that can't be exercised by a digital
// test. Distinct from acceptAc/rejectAc above — those transition the AC's
// lifecycle *status* (proposed → active); these set/clear the *verification*
// overlay (accepted_by/accepted_at on the acs row).
//
// Evidence wins: the overlay is suppressed by failing test evidence in
// deriveVerificationState, never auto-deleted. Un-accept nulls both columns.

/**
 * Record a manual acceptance on an AC. `actor` is a display snapshot
 * (user.name ?? email) — same posture as test_events.actor. Re-accepting an
 * already-accepted AC refreshes actor + timestamp (idempotent in effect).
 */
export async function setAcAcceptance(
  memexId: string,
  acId: string,
  actor: string,
  ctx: RequestCtx = {},
): Promise<Mutated<Ac>> {
  if (!actor.trim()) {
    throw new ValidationError("actor is required to accept an AC");
  }
  const ac = await getAc(memexId, acId); // tenancy check
  return mutate(
    ctx,
    { memexId, docId: ac.briefId, entity: "ac", action: "updated" },
    async () => {
      const [row] = await db
        .update(acs)
        .set({
          acceptedBy: actor.trim(),
          acceptedAt: new Date(),
          updatedAt: new Date(),
          ...(await resolveActorColumns(ctx)),
        })
        .where(and(eq(acs.id, acId), eq(acs.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

/**
 * Revoke a manual acceptance — nulls accepted_by/accepted_at, restoring the
 * purely test-derived verification state. No-op-shaped if not accepted
 * (throws ConflictError so the UI can't silently un-accept nothing).
 */
export async function clearAcAcceptance(
  memexId: string,
  acId: string,
  ctx: RequestCtx = {},
): Promise<Mutated<Ac>> {
  const ac = await getAc(memexId, acId); // tenancy check
  if (ac.acceptedAt === null) {
    throw new ConflictError(`AC ${acId} has no acceptance to revoke`);
  }
  return mutate(
    ctx,
    { memexId, docId: ac.briefId, entity: "ac", action: "updated" },
    async () => {
      const [row] = await db
        .update(acs)
        // spec-391: clearing the acceptance also clears the reviewed-verification
        // rationale — the reason is meaningless without the sign-off it explains.
        .set({
          acceptedBy: null,
          acceptedAt: null,
          reviewedReason: null,
          updatedAt: new Date(),
          ...(await resolveActorColumns(ctx)),
        })
        .where(and(eq(acs.id, acId), eq(acs.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

// ══════════════════════════════════════════════════════════════════════
// Reviewed-verification sign-off (spec-391 dec-2)
// ══════════════════════════════════════════════════════════════════════
//
// The first-class reviewed-verification AC class — dec-2's escape hatch for the
// hard verify→done AC gate. A config/prose/Dashboard AC that cannot carry an
// automated test (Stripe settings, Apple notarization, policy ACs) is given a
// named, dated, REASONED human sign-off so it satisfies the gate (it derives to
// the `accepted` verification state) instead of permanently wedging the spec.
//
// This is an EXTENSION of spec-188's manual acceptance: it sets the same
// accepted_by/accepted_at overlay AND a reviewed_reason explaining why the AC
// can't be tested. The distinction from a bare setAcAcceptance is the recorded
// rationale — the gate and the audit can name it. Evidence still wins: a
// failing test suppresses the accepted state in deriveVerificationState.
//
// Unlike setAcAcceptance (which passes {} to mutate), this threads the caller's
// RequestCtx so actor_user_id/actor_name/channel are stamped per std-32 — a
// sign-off is a load-bearing human attribution, not an anonymous overlay write.

/**
 * Record a reviewed-verification sign-off on an AC: sets accepted_by +
 * accepted_at + reviewed_reason together. `actor` is the display snapshot
 * (user.name ?? email); `reason` explains why this AC cannot carry an automated
 * test. Both are required. Re-signing refreshes actor + timestamp + reason
 * (idempotent in effect). The activity contract columns are stamped from `ctx`.
 */
export async function setAcReviewedVerification(
  memexId: string,
  acId: string,
  actor: string,
  reason: string,
  ctx: RequestCtx = {},
): Promise<Mutated<Ac>> {
  if (!actor.trim()) {
    throw new ValidationError("actor is required to sign off an AC");
  }
  if (!reason.trim()) {
    throw new ValidationError(
      "a reason is required for a reviewed-verification sign-off (why this AC cannot carry an automated test)",
    );
  }
  const ac = await getAc(memexId, acId); // tenancy check
  return mutate(
    ctx,
    { memexId, docId: ac.briefId, entity: "ac", action: "updated" },
    async () => {
      const [row] = await db
        .update(acs)
        .set({
          acceptedBy: actor.trim(),
          acceptedAt: new Date(),
          reviewedReason: reason.trim(),
          updatedAt: new Date(),
          // std-32: stamp WHO + HOW from the request context on the sign-off.
          ...(await resolveActorColumns(ctx)),
        })
        .where(and(eq(acs.id, acId), eq(acs.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

// ══════════════════════════════════════════════════════════════════════
// Test-event matrix (b-96) — per-AC history view + discontinue
// ══════════════════════════════════════════════════════════════════════
//
// The verification view aggregates per `test_identifier` into a single latest
// status. That hides orphans: a `test_identifier` whose tagged source has been
// renamed or deleted in the codebase keeps its last `fail` emission forever
// and shows up indistinguishable from an active failing test.
//
// The matrix surfaces every distinct `test_identifier` for an AC alongside
// the full emission timeline so a human can recognise "I renamed that test;
// the old row is junk" and discontinue it. Discontinue is a hard delete of
// the matching rows in `test_events`; there is no soft-delete state, no
// `discontinued_at` column, no audit log on this table. Re-emission produces
// a fresh row with new history — the data IS the state.

export interface TestEventEmission {
  status: "pass" | "fail" | "error";
  emittedAt: Date;
  /**
   * Actor — WHO emitted this event (spec-115 dec-6, spec-122 activity
   * contract). Top-level sibling of metadata. Null when the emission did
   * not include actor (pre-v0.1.0 wire format or a helper with no env-var
   * actor available).
   */
  actor?: string | null;
  /**
   * Extensible metadata bag (spec-115 v0.1.0). When the test posted
   * metadata with its emission, it lands here on the matrix view so the
   * admin UI tooltip can surface it. Null/undefined when no metadata was
   * posted (the common case for pre-v0.1.0 emissions).
   */
  metadata?: Record<string, string> | null;
}

export interface TestMatrixRow {
  /** test_identifier as emitted by the helper, or empty string when null. */
  testIdentifier: string;
  /** Every emission ever recorded for this (subject_ref, test_identifier), newest-first. */
  emissions: TestEventEmission[];
}

/**
 * Read the full test-event history for one AC, grouped by `test_identifier`,
 * each row's emissions newest-first by `created_at`.
 *
 * No server-side run-batching, no `run_id`-aware grouping, no inferred
 * "didn't run" cells (b-96 dec-11). One column entry per `test_events` row.
 */
export async function listTestMatrixForAc(
  memexId: string,
  acId: string,
): Promise<TestMatrixRow[]> {
  const ac = await getAc(memexId, acId); // tenancy check; 404 via NotFoundError
  const slugs = await resolveBriefSlugsForRef(ac.briefId);
  const subjectRef = buildAcRef(slugs, ac.seq);

  // spec-115 v0.1.0: hidden events are excluded from the matrix view too —
  // the matrix is the per-AC verification timeline that drives the badge.
  // Hidden audit history is in the DB but not surfaced in v0.1.0.
  const events = await db.query.testEvents.findMany({
    where: and(eq(testEvents.subjectRef, subjectRef), eq(testEvents.hidden, false)),
    orderBy: [desc(testEvents.createdAt)],
  });

  const byTestIdentifier = new Map<string, TestEventEmission[]>();
  for (const ev of events) {
    const key = ev.testIdentifier ?? "";
    const list = byTestIdentifier.get(key) ?? [];
    list.push({
      status: ev.status as "pass" | "fail" | "error",
      emittedAt: ev.createdAt,
      actor: ev.actor ?? null,
      metadata: ev.metadata ?? null,
    });
    byTestIdentifier.set(key, list);
  }

  // Stable row ordering across reads — emissions already DESC from the query.
  return Array.from(byTestIdentifier.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([testIdentifier, emissions]) => ({ testIdentifier, emissions }));
}

// ──────────────────────────────────────────────────────────────────────
// Agent-facing test-event digest (spec-127 dec-2) — the ref-keyed read tool
// ──────────────────────────────────────────────────────────────────────
//
// listTestMatrixForAc EXCLUDES hidden rows (it drives the human badge timeline).
// The agent surface needs MORE: it must show which identifiers currently PIN the
// AC red (candidates for discontinue) AND which are already retired/hidden
// (candidates for restore). So this read sees every emission — hidden and not —
// and collapses to one digest row per test_identifier, computing the
// verdict-relevant view (latest NON-hidden status) alongside a `hidden` flag.

export interface TestEventDigestRow {
  /** test_identifier as emitted, or "" for the null bucket. */
  testIdentifier: string;
  /**
   * Status of the latest NON-hidden emission — what the verdict actually sees
   * (the verdict reads test_event_latest, which excludes hidden; spec-162).
   * null when every emission for the pair is hidden (fully retired).
   */
  latestStatus: "pass" | "fail" | "error" | null;
  /** created_at of the latest non-hidden emission, or null when fully retired. */
  latestRunAt: Date | null;
  /** commit_sha of the latest non-hidden emission (best-effort, often null). */
  lastCommit: string | null;
  /** Total emissions recorded (hidden + visible) — the audit depth. */
  count: number;
  /** No non-hidden emission remains — currently retired / invisible to the badge. */
  hidden: boolean;
  /** Latest non-hidden emission is fail/error — this identifier pins the AC red. */
  pinning: boolean;
}

export async function listTestEventDigestForAc(
  memexId: string,
  acId: string,
): Promise<TestEventDigestRow[]> {
  const ac = await getAc(memexId, acId); // tenancy check; 404 via NotFoundError
  const slugs = await resolveBriefSlugsForRef(ac.briefId);
  const subjectRef = buildAcRef(slugs, ac.seq);

  const events = await db.query.testEvents.findMany({
    where: eq(testEvents.subjectRef, subjectRef),
    orderBy: [desc(testEvents.createdAt)],
  });

  const byId = new Map<string, typeof events>();
  for (const ev of events) {
    const key = ev.testIdentifier ?? "";
    const list = byId.get(key) ?? [];
    list.push(ev);
    byId.set(key, list);
  }

  const rows: TestEventDigestRow[] = [];
  for (const [testIdentifier, evs] of byId.entries()) {
    // evs are newest-first; the latest non-hidden emission is the verdict view.
    const latestVisible = evs.find((e) => !e.hidden) ?? null;
    const latestStatus = (latestVisible?.status ?? null) as
      | "pass"
      | "fail"
      | "error"
      | null;
    rows.push({
      testIdentifier,
      latestStatus,
      latestRunAt: latestVisible?.createdAt ?? null,
      lastCommit: latestVisible?.commitSha ?? evs[0]?.commitSha ?? null,
      count: evs.length,
      hidden: latestVisible === null,
      pinning: latestStatus === "fail" || latestStatus === "error",
    });
  }
  return rows.sort((a, b) => a.testIdentifier.localeCompare(b.testIdentifier));
}

/**
 * Hard-delete every `test_events` row matching `(subjectRef, testIdentifier)` for
 * the AC. Writes no audit record (b-96 dec-14): no admin_actions row, no
 * auto-comment, no `discontinued_at` column. The deletion leaves no trace
 * beyond the rows removed.
 *
 * Emits an `ac:updated` change so the AC's verification state and the
 * matrix view re-render across all subscribed surfaces (std-8).
 */
export async function discontinueTestEventsForAc(
  memexId: string,
  acId: string,
  testIdentifier: string,
): Promise<Mutated<{ deleted: number }>> {
  const ac = await getAc(memexId, acId); // tenancy check; 404 via NotFoundError
  const slugs = await resolveBriefSlugsForRef(ac.briefId);
  const subjectRef = buildAcRef(slugs, ac.seq);

  return mutate(
    {},
    { memexId, docId: ac.briefId, entity: "ac", action: "updated" },
    // spec-162 dec-1 / ac-7: hard-delete the log rows AND drop the summary row
    // for this pair in one transaction, so a discontinued test disappears from
    // the badge immediately with no stale 'latest' left behind.
    async () => {
      return db.transaction(async (tx) => {
        const rows = await tx
          .delete(testEvents)
          .where(
            and(
              eq(testEvents.subjectRef, subjectRef),
              eq(testEvents.testIdentifier, testIdentifier),
            ),
          )
          .returning({ id: testEvents.id });
        await removeSummaryForPair(tx, subjectRef, testIdentifier);
        return { deleted: rows.length };
      });
    },
  );
}

// ══════════════════════════════════════════════════════════════════════
// Orphan retirement is HARD-DELETE only (spec-358 dec-1)
// ══════════════════════════════════════════════════════════════════════
//
// The soft-hide / restore pair (spec-127) was the last writer of
// `test_events.hidden`. spec-358 removes it: orphan retirement now goes
// through `discontinueTestEventsForAc` above (hard delete), the same thing the
// UI `DeleteTestEventsButton` and the MCP `discontinue_test_events` tool do.
// Nothing writes `hidden=true` anymore — the column is frozen at its current
// contents (dec-2) and every reader that excludes historical hidden rows is
// kept. The only thing given up is reversibility/audit of an orphan retirement
// (a thin safety net for a test that no longer exists).

// ══════════════════════════════════════════════════════════════════════
// Per-Spec decision → implementation-AC coverage
// ══════════════════════════════════════════════════════════════════════
//
// Powers two surfaces:
//   1. The `list_acs` aggregate header — surfaces "K resolved decisions · M
//      with implementation ACs" so the gap is visible on every list call.
//   2. The `assess_spec({target:'build'})` rubric — a resolved decision with
//      zero implementation ACs is a hold-flavoured signal.
//
// Both surfaces derive identically — a resolved decision's children are
// counted as implementation ACs only when the child AC's own status is
// `active`. Proposed / rejected / superseded children don't satisfy the rule.
// See guidance topic `decisions-need-acs` for the discipline.

export interface DecisionImplAcCount {
  decisionId: string;
  decisionHandle: string;
  decisionTitle: string;
  implementationAcCount: number;
}

/**
 * For every `resolved` decision on a Spec, count its child `active`
 * implementation ACs (linked via `ac_parent_links` with parent_kind='decision').
 *
 * Returns one row per resolved decision (count=0 included). Order matches
 * the decision's `seq`, ascending.
 */
export async function listResolvedDecisionImplAcCoverage(
  memexId: string,
  briefId: string,
): Promise<DecisionImplAcCount[]> {
  const resolvedDecisions = await db
    .select({ id: decisions.id, seq: decisions.seq, title: decisions.title })
    .from(decisions)
    .where(
      and(
        eq(decisions.memexId, memexId),
        eq(decisions.docId, briefId),
        eq(decisions.status, "resolved"),
      ),
    )
    .orderBy(asc(decisions.seq));
  if (resolvedDecisions.length === 0) return [];

  const decisionIds = resolvedDecisions.map((d) => d.id);
  const linkRows = await db
    .select({ decisionId: acParentLinks.parentId, acId: acs.id })
    .from(acParentLinks)
    .innerJoin(acs, eq(acs.id, acParentLinks.acId))
    .where(
      and(
        eq(acParentLinks.parentKind, "decision"),
        inArray(acParentLinks.parentId, decisionIds),
        eq(acs.kind, "implementation"),
        eq(acs.status, "active"),
      ),
    );
  const countByDecisionId = new Map<string, number>();
  for (const row of linkRows) {
    countByDecisionId.set(
      row.decisionId,
      (countByDecisionId.get(row.decisionId) ?? 0) + 1,
    );
  }
  return resolvedDecisions.map((d) => ({
    decisionId: d.id,
    decisionHandle: `dec-${d.seq}`,
    decisionTitle: d.title,
    implementationAcCount: countByDecisionId.get(d.id) ?? 0,
  }));
}

// ══════════════════════════════════════════════════════════════════════
// AC health roll-up — the per-Spec six-number summary for the board (b-66)
// ══════════════════════════════════════════════════════════════════════
//
// Aggregator for the Specs board. Returns one AcHealth per Spec id in
// `briefIds`, using the SAME `deriveVerificationState` + `STALE_THRESHOLD_DAYS`
// + `buildAcRef` helpers as `listAcsForBriefWithVerification`. This is
// b-66 Scope AC-3 in code: card state and AC tab state cannot disagree
// because they share the derivation.
//
// Budget: two queries regardless of Spec count.
//   Q1 — every active AC for the Spec set, joined with namespace/memex/doc
//        slugs so each row carries enough to compute its canonical ref.
//   Q2 — every test_events row whose subject_ref is in the universe Q1 produced.
// Aggregation, latest-per-test reduction, and state derivation all happen
// in JS — same shape as `listAcsForBriefWithVerification`, scaled to N
// Specs in a single round-trip pair.
//
// Specs in `briefIds` that have ZERO active ACs DO appear in the returned
// map, with `totalActive: 0` (and every other count 0). The caller chooses
// whether to attach the field or omit it; `listDocs` omits it so the wire
// shape matches the absence-of-signal rule (b-66 Scope AC-4) by default.

export interface AcHealth {
  totalActive: number;
  /** Active ACs with ≥1 tagged test event (any status). */
  covered: number;
  /** Verified by `deriveVerificationState` — all tests pass, none stale. */
  verified: number;
  /** Any tagged test latest-status is 'fail' or 'error'. Failing wins
   *  over stale/verified when computing this Spec's dominant state. */
  failing: number;
  /** All tagged tests pass but the most recent run is older than
   *  STALE_THRESHOLD_DAYS. */
  stale: number;
  /** No tagged test events ever — the silent-no-emit case. */
  untested: number;
  /** Manually accepted (spec-188 dec-1) with no failing evidence. Counts
   *  toward the verified percentage in UI metrics but is tallied separately
   *  so surfaces can keep the human-vs-test distinction visible. */
  accepted: number;
}

const EMPTY_HEALTH: AcHealth = {
  totalActive: 0,
  covered: 0,
  verified: 0,
  failing: 0,
  stale: 0,
  untested: 0,
  accepted: 0,
};

export async function aggregateAcHealthForBriefs(
  memexId: string,
  briefIds: readonly string[],
): Promise<Map<string, AcHealth>> {
  const result = new Map<string, AcHealth>();
  // Seed every requested Spec with the empty payload up-front so the
  // caller can iterate the input list and always find a value. Callers
  // distinguishing "Spec had no active ACs" from "Spec not aggregated"
  // can compare against this constant.
  for (const id of briefIds) result.set(id, { ...EMPTY_HEALTH });
  if (briefIds.length === 0) return result;

  // Q1 — active ACs + their canonical-ref slug components in one join.
  // Tenancy is double-locked (memexId on acs AND briefId in the set) so
  // a stray cross-tenant id can't return rows.
  const acRows = await db
    .select({
      acId: acs.id,
      briefId: acs.briefId,
      seq: acs.seq,
      acceptedAt: acs.acceptedAt,
      namespace: namespaces.slug,
      memex: memexes.slug,
      briefHandle: documents.handle,
    })
    .from(acs)
    .innerJoin(documents, eq(acs.briefId, documents.id))
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(
      and(
        eq(acs.memexId, memexId),
        eq(acs.status, "active"),
        inArray(acs.briefId, briefIds as string[]),
      ),
    );
  if (acRows.length === 0) return result;

  // Materialise the canonical ref per AC up-front via buildAcRef — never
  // hand-stitch the path. Any divergence here from listAcsForBriefWithVerification
  // would silently break the test_events join and the card colour would lie.
  const refsByAcId = new Map<string, string>();
  const briefByAcRef = new Map<string, string>();
  for (const row of acRows) {
    if (!row.briefHandle) continue;
    const ref = buildAcRef(
      {
        namespace: row.namespace,
        memex: row.memex,
        briefHandle: row.briefHandle,
      },
      row.seq,
    );
    refsByAcId.set(row.acId, ref);
    briefByAcRef.set(ref, row.briefId);
  }
  const allRefs = Array.from(refsByAcId.values());
  if (allRefs.length === 0) return result;

  // Q2 — spec-162: the latest-per-pair summary for the AC universe, read directly from
  // test_event_latest.
  //
  // spec-520 t-4 (dec-1, ac-7): ONE tenant parameter, not one per AC ref.
  //
  // This used to bind `subject_ref IN (…)` with every active ref — up to 3,745 values,
  // 25KB of SQL. The cost that buys is not what the old comment ("bounded by active AC×test
  // pairs, not by history depth") suggests:
  //
  //   • Each distinct bind-parameter COUNT is its own prepared statement, its own plan-cache
  //     entry and its own pg_stat_statements row. Measured on prod: 1,098 fingerprints on
  //     2026-08-18, 1,223 on 2026-08-28 — ~12/day, and ~24.5% of the instance's entire
  //     5,000-entry cap, which is 98.6% full and already evicting (issue-10). One logical
  //     read presenting as a thousand also makes that table illegible to anyone reading it
  //     for top costs.
  //   • Planning time 7.564 ms for the 1,800-literal form versus 0.037 ms for the simple
  //     one — 200×, paid on every call before a row is touched.
  //
  // ⚠ DO NOT SIZE THIS AS A LATENCY FIX. s-4 §3 EXPLAINed both forms at ~48 ms with
  // everything in shared_hit on a quiet connection, while pg_stat_statements puts the same
  // read at a 642 ms mean in production. That 13× gap is contention and cache state, not
  // plan shape, so a rewrite that only changes the plan will not deliver 642 → 48.
  //
  // ⚠ AND THE PLAN WILL PROBABLY STAY A SEQ SCAN for the tenant that matters, which is
  // correct: one Memex holds 81.0% of this table (147,989 of 182,634 rows), so
  // `memex_id = $1` selects four rows in five and an index scan would be slower. ac-8
  // expects an index scan and is wrong for that tenant — see c-4.
  //
  // Over-fetching rows for ACs outside the requested Spec set is the accepted trade-off
  // (dec-1): they are all read today anyway, since the seq scan touches every row. The
  // bucketing below drops them, so the map stays bounded by the requested universe and
  // parity is exact by construction rather than by argument.
  const summaryRows = await db
    .select({
      subjectRef: testEventLatest.subjectRef,
      testIdentifier: testEventLatest.testIdentifier,
      latestStatus: testEventLatest.latestStatus,
      latestRunAt: testEventLatest.latestRunAt,
      runCount: testEventLatest.runCount,
    })
    .from(testEventLatest)
    .where(eq(testEventLatest.memexId, memexId));

  // Bucket the summary rows into per-AC snapshots in the same shape the AC tab
  // consumes, so deriveVerificationState gets identical input — card colour and
  // tab agree by construction (ac-2 parity). '' maps back to null.
  const snapshotsByRef = new Map<string, AcTestSnapshot[]>();
  // spec-520 t-4: the read is now tenant-wide, so skip refs outside the requested universe.
  // The tally below looks refs UP rather than iterating this map, so extra entries would be
  // inert either way — this keeps the map bounded by the ACs actually asked about.
  const wantedRefs = new Set(allRefs);
  for (const row of summaryRows) {
    if (!wantedRefs.has(row.subjectRef)) continue;
    const list = snapshotsByRef.get(row.subjectRef) ?? [];
    list.push({
      testIdentifier: row.testIdentifier === "" ? null : row.testIdentifier,
      latestStatus: row.latestStatus as "pass" | "fail" | "error",
      latestRunAt: row.latestRunAt,
      runCount: row.runCount,
    });
    snapshotsByRef.set(row.subjectRef, list);
  }

  const now = Date.now();
  // Tally per Spec, deriving each AC's state via the shared helper so
  // card and tab agree by construction.
  for (const row of acRows) {
    const ref = refsByAcId.get(row.acId);
    if (!ref) continue;
    const tests = snapshotsByRef.get(ref) ?? [];
    const latestRunAt = tests.reduce<Date | null>(
      (acc, t) => (acc === null || t.latestRunAt > acc ? t.latestRunAt : acc),
      null,
    );
    const daysSinceLastRun =
      latestRunAt === null
        ? null
        : Math.floor((now - latestRunAt.getTime()) / (1000 * 60 * 60 * 24));
    const state = deriveVerificationState(
      tests,
      daysSinceLastRun,
      row.acceptedAt !== null,
    );

    const health = result.get(row.briefId);
    if (!health) continue;
    health.totalActive += 1;
    if (tests.length > 0) health.covered += 1;
    switch (state) {
      case "verified":
        health.verified += 1;
        break;
      case "failing":
        health.failing += 1;
        break;
      case "stale":
        health.stale += 1;
        break;
      case "untested":
        health.untested += 1;
        break;
      case "accepted":
        health.accepted += 1;
        break;
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════
// Alignment-history view — the 30-day sparkline data
// ══════════════════════════════════════════════════════════════════════

export interface AlignmentDay {
  /** ISO date string (YYYY-MM-DD), the day this snapshot describes. */
  date: string;
  /** Count of ACs with a latest-pass on this day (and not failing). */
  verified: number;
  /** Count of ACs in scope this day (active + had a relevant emission). */
  total: number;
  /** Same as listAcsForBriefWithVerification, broken down by kind. */
  kind: "scope" | "implementation";
}

/**
 * For each of the last `days` days × each AC `kind`, compute (verified, total)
 * where:
 *   - total  = ACs active on that day (created on or before; status='active'
 *              today — V0.0.1 simplification, we don't reconstruct historical
 *              status transitions, which would require an audit table)
 *   - verified = ACs whose latest test_event AS OF END-OF-DAY is 'pass'
 *
 * V0.0.1 caveat: status reconstruction is not historical. An AC currently
 * `rejected` or `superseded` is excluded from the total even on days when it
 * was active. Acceptable for now — the sparkline tells the alignment story for
 * what we care about TODAY; backfilling true historical status would need a
 * status-event log we don't have.
 *
 * SQL is a window-function pair per day, fanned out via generate_series. The
 * heavy lifting is the LATERAL join that finds the latest test event per
 * (subject_ref, day) ≤ end-of-day. Bounded by the AC set in the Spec, which is
 * small (rarely >100), so this is cheap even at 90 days.
 */
export async function listAcAlignmentOverTime(
  memexId: string,
  briefId: string,
  days = 30,
): Promise<AlignmentDay[]> {
  await assertBriefInMemex(memexId, briefId);
  const slugs = await resolveBriefSlugsForRef(briefId);

  const acRows = await db.query.acs.findMany({
    where: and(
      eq(acs.memexId, memexId),
      eq(acs.briefId, briefId),
      eq(acs.status, "active"),
    ),
  });
  if (acRows.length === 0) return [];

  // Build ac_set as an inline VALUES list — avoids passing JS arrays through
  // unnest(...::text[]) (postgres-js doesn't auto-cast TS arrays to Postgres
  // arrays in parameter binding). Each row is parameterised, so this is still
  // SQL-injection-safe.
  const acSetValues = sql.join(
    acRows.map(
      (a) =>
        sql`(${buildAcRef(slugs, a.seq)}, ${a.kind}, ${a.createdAt.toISOString()}::timestamptz, ${
          a.acceptedAt ? a.acceptedAt.toISOString() : null
        }::timestamptz)`,
    ),
    sql`, `,
  );

  // For each (day × ac), find the latest event ≤ end-of-day for that subject_ref;
  // 'verified' iff that latest is 'pass'. Total = ACs that existed by then.
  const rows = (await db.execute(sql`
    WITH ac_set(subject_ref, kind, created_at, accepted_at) AS (
      VALUES ${acSetValues}
    ),
    series AS (
      SELECT generate_series(
        date_trunc('day', now()) - (${days - 1} || ' days')::interval,
        date_trunc('day', now()),
        '1 day'::interval
      )::date AS day
    ),
    daily AS (
      SELECT
        s.day,
        a.kind,
        a.subject_ref,
        a.created_at,
        a.accepted_at,
        (
          SELECT te.status
          FROM test_events te
          WHERE te.subject_ref = a.subject_ref
            AND te.created_at < (s.day + INTERVAL '1 day')
          ORDER BY te.created_at DESC
          LIMIT 1
        ) AS latest_status
      FROM series s
      CROSS JOIN ac_set a
    )
    SELECT
      day::text AS date,
      kind,
      COUNT(*) FILTER (WHERE created_at <= day + INTERVAL '1 day') AS total,
      -- Gate verified on AC existence too — otherwise a test_event predating
      -- the AC's createdAt (only possible with synthetic seed data, but the
      -- contract should hold) yields verified > total, which is nonsense.
      --
      -- spec-188 dec-1/dec-2: a manual acceptance counts as verified from the
      -- day it was recorded, with the same evidence-wins precedence as
      -- deriveVerificationState — a failing/erroring latest status suppresses
      -- it. (V0.0.1 caveat, same as status above: accepted_at is TODAY's
      -- value, not historically reconstructed across un-accept cycles.)
      COUNT(*) FILTER (
        WHERE created_at <= day + INTERVAL '1 day'
          AND (
            latest_status = 'pass'
            OR (
              accepted_at IS NOT NULL
              AND accepted_at < day + INTERVAL '1 day'
              AND (latest_status IS NULL OR latest_status = 'pass')
            )
          )
      ) AS verified
    FROM daily
    GROUP BY day, kind
    ORDER BY day ASC, kind ASC
  `)) as unknown as Array<{
    date: string;
    kind: "scope" | "implementation";
    total: string | number;
    verified: string | number;
  }>;

  return rows.map((r) => ({
    date: r.date,
    kind: r.kind,
    total: Number(r.total),
    verified: Number(r.verified),
  }));
}

// ══════════════════════════════════════════════════════════════════════
// CI-emission audit — "stale = local-only" (spec-391 dec-4, ac-10)
// ══════════════════════════════════════════════════════════════════════
//
// A VERIFIED AC whose proof came from a laptop, not CI, is weak verification:
// the deploy signal can't trust a green that only ever ran on someone's machine.
// This audit flags any verified AC whose LATEST emission lacks CI provenance.
//
// CI-originated (dec-4) = the latest non-hidden emission has a non-null
// top-level `run_id` OR a `run_id`/`run_url` key in `metadata` (the helper
// auto-populates these only in CI: GitHub Actions / GitLab / BuildKite /
// CircleCI; a laptop run sets none). run_id is the sharpest discriminator;
// metadata is the fallback for hand-rolled emitters. Read-only — NEVER blocks a
// transition (it informs; the deploy block is dec-1/dec-3's untested/failing
// gate, not provenance).
//
// "non-hidden": test_events.hidden is frozen-false post spec-358, but we keep
// the filter so the audit reads what the badge reads.

/** True when an emission carries a CI run marker (dec-4). */
export function emissionIsCiOriginated(ev: {
  runId: string | null;
  metadata: Record<string, string> | null | undefined;
}): boolean {
  if (ev.runId != null && ev.runId.trim() !== "") return true;
  const md = ev.metadata ?? {};
  const runId = md["run_id"];
  const runUrl = md["run_url"];
  return (
    (typeof runId === "string" && runId.trim() !== "") ||
    (typeof runUrl === "string" && runUrl.trim() !== "")
  );
}

export interface CiEmissionAuditRow {
  /** `ac-N` handle of a VERIFIED AC whose latest emission is local-only. */
  handle: string;
}

/**
 * For every VERIFIED active AC on the spec, inspect its latest non-hidden
 * emission and flag the ones lacking CI provenance ("local-only"). Returns one
 * row per flagged AC (empty when every verified AC's proof came from CI). Pure
 * read; the caller decides how to surface it.
 */
export async function auditCiEmissionForBrief(
  memexId: string,
  briefId: string,
): Promise<CiEmissionAuditRow[]> {
  const rows = await listAcsForBriefWithVerification(memexId, briefId);
  const verified = rows.filter(
    (r) => r.ac.status === "active" && r.verificationState === "verified",
  );
  if (verified.length === 0) return [];

  const out: CiEmissionAuditRow[] = [];
  for (const r of verified) {
    // spec-520 dec-8 option A: provenance now comes from the SUMMARY, not the raw log.
    //
    // This reads the latest emission of an AC that is ALREADY verified, so the row can be
    // arbitrarily old. Retention keeps 10 rows per pair today, which for a rarely-run test
    // spans months — but t-12 replaces that with a short TIME window, at which point the raw
    // row is gone and `if (!latest) continue` would report "no local-only ACs". That is a
    // FALSE NEGATIVE on a provenance audit, and it reaches assess_spec's phase rubric, so it
    // would tell a reader the evidence is stronger than it is at a phase decision.
    //
    // test_event_latest holds one row per (subject_ref, test_identifier); the newest overall
    // is the greatest latest_run_at, and 0137 carries that emission's run id and metadata
    // beside it.
    const [latest] = await db
      .select({
        runId: testEventLatest.latestRunId,
        metadata: testEventLatest.latestMetadata,
        runAt: testEventLatest.latestRunAt,
      })
      .from(testEventLatest)
      .where(eq(testEventLatest.subjectRef, r.canonicalRef))
      .orderBy(desc(testEventLatest.latestRunAt))
      .limit(1);
    // A verified AC always has ≥1 passing emission; defensively skip if none.
    if (!latest) continue;
    // ⚠ NULL metadata means "never observed", NOT "not CI". Rows written before 0137 carry
    // no provenance and nothing can recover it — the raw rows that knew are exactly the ones
    // retention deletes. Judging them would report every pre-existing AC as laptop-verified:
    // a FALSE POSITIVE, the mirror of the false negative above, and just as misleading at a
    // phase decision. From 0137 on the writer stores `{}` rather than null when an emission
    // carries no metadata, so NULL here means one thing only, and UNKNOWN skips — exactly
    // what a missing row does today.
    if (latest.metadata == null) continue;
    if (!emissionIsCiOriginated({ runId: latest.runId, metadata: latest.metadata })) {
      out.push({ handle: `ac-${r.ac.seq}` });
    }
  }
  return out;
}
