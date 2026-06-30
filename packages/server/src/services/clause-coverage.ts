// spec-151 dec-4 (t-7) — the clause-COVERAGE read side. Mirrors
// listAcsForBriefWithVerification (services/acs.ts) but keyed by a standard-clause
// ref, with two spec-151 twists:
//   • CI-backed-green honesty (dec-4 / ac-12, ac-13): a passing clause whose
//     LATEST emission lacks CI provenance reads "local", not "verified" — only a
//     CI-backed green counts as enforced-at-merge.
//   • a denominator of only TESTABLE OBLIGATIONS (ac-16): non-obligations and
//     untestable clauses are excluded from the coverage %.
//
// Reuses deriveVerificationState + emissionIsCiOriginated (acs.ts) and
// isCoverageCountable (testability.ts) so clause and AC coverage can never drift.

import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  memexes,
  namespaces,
  standardClauses,
  testEventLatest,
  testEvents,
} from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";
import {
  deriveVerificationState,
  emissionIsCiOriginated,
  type AcTestSnapshot,
} from "./acs.js";
import { isCoverageCountable } from "./testability.js";

export interface StandardSlugs {
  namespace: string;
  memex: string;
  standardHandle: string;
}

/**
 * The canonical clause ref. MUST match the grammar tests tag with
 * (`tagClause(...)`) and the route stores, or the test_event_latest join silently
 * misses — the same contract buildAcRef holds for ACs.
 */
export function buildClauseRef(slugs: StandardSlugs, clauseSeq: number): string {
  return `${slugs.namespace}/${slugs.memex}/standards/${slugs.standardHandle}/clauses/cl-${clauseSeq}`;
}

// "verified" = CI-backed green; "local" = passing but NOT CI-backed (dec-4).
export type ClauseCoverageState =
  | "verified"
  | "local"
  | "failing"
  | "stale"
  | "untested";

export interface ClauseWithVerification {
  clause: {
    id: string;
    seq: number;
    body: string;
    isObligation: boolean | null;
    testable: boolean | null;
    archetype: string | null;
  };
  canonicalRef: string;
  tests: AcTestSnapshot[];
  state: ClauseCoverageState;
  /** Latest emission carries CI provenance (run_id / run_url). */
  ciBacked: boolean;
  /** Counts toward the coverage denominator (a testable obligation, ac-16). */
  countable: boolean;
  daysSinceLastRun: number | null;
}

export interface StandardClauseCoverage {
  clauses: ClauseWithVerification[];
  /** Denominator: testable obligations only (ac-16). */
  countableTotal: number;
  /** Countable clauses with ≥1 tagged test. */
  coveredCount: number;
  /** Countable clauses that are CI-backed green (the honest "enforced at merge"). */
  verifiedCount: number;
}

async function resolveStandardSlugs(docId: string): Promise<StandardSlugs> {
  const [row] = await db
    .select({
      namespace: namespaces.slug,
      memex: memexes.slug,
      handle: documents.handle,
      docType: documents.docType,
    })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(documents.id, docId))
    .limit(1);
  if (!row || !row.handle) {
    throw new NotFoundError(`Standard ${docId} not found or has no handle`);
  }
  if (row.docType !== "standard") {
    throw new NotFoundError(`Doc ${docId} is not a standard`);
  }
  return { namespace: row.namespace, memex: row.memex, standardHandle: row.handle };
}

/**
 * Per-clause coverage + verification for a standard, plus the aggregate counts
 * the coverage badge reads. Mirrors the AC matrix read path.
 */
export async function listClausesForStandardWithVerification(
  memexId: string,
  docId: string,
): Promise<StandardClauseCoverage> {
  const slugs = await resolveStandardSlugs(docId);

  const clauseRows = await db
    .select({
      id: standardClauses.id,
      seq: standardClauses.seq,
      body: standardClauses.body,
      isObligation: standardClauses.isObligation,
      testable: standardClauses.testable,
      archetype: standardClauses.archetype,
    })
    .from(standardClauses)
    .where(and(eq(standardClauses.docId, docId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position));
  if (clauseRows.length === 0) {
    return { clauses: [], countableTotal: 0, coveredCount: 0, verifiedCount: 0 };
  }

  const refBySeq = new Map(clauseRows.map((c) => [c.seq, buildClauseRef(slugs, c.seq)]));
  const allRefs = Array.from(refBySeq.values());

  // Latest-per-(subject_ref, test_identifier) summary — same fast read the AC tab
  // uses, keyed by clause ref instead of AC ref.
  const summaryRows = await db
    .select({
      subjectRef: testEventLatest.subjectRef,
      testIdentifier: testEventLatest.testIdentifier,
      latestStatus: testEventLatest.latestStatus,
      latestRunAt: testEventLatest.latestRunAt,
      runCount: testEventLatest.runCount,
    })
    .from(testEventLatest)
    .where(inArray(testEventLatest.subjectRef, allRefs));

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
  const clauses: ClauseWithVerification[] = [];
  for (const c of clauseRows) {
    const ref = refBySeq.get(c.seq)!;
    const tests = testsByRef.get(ref) ?? [];
    const latestRunAt = tests.reduce<Date | null>(
      (acc, t) => (acc === null || t.latestRunAt > acc ? t.latestRunAt : acc),
      null,
    );
    const daysSinceLastRun =
      latestRunAt === null
        ? null
        : Math.floor((now - latestRunAt.getTime()) / (1000 * 60 * 60 * 24));

    // Clauses are never manually accepted (accepted=false), so deriveVerificationState
    // returns only failing / untested / stale / verified.
    const base = deriveVerificationState(tests, daysSinceLastRun, false);

    let ciBacked = false;
    let state: ClauseCoverageState;
    if (base === "failing" || base === "untested" || base === "stale") {
      state = base;
    } else {
      // base === "verified": demand CI provenance on the latest emission (dec-4).
      const [latest] = await db
        .select({ runId: testEvents.runId, metadata: testEvents.metadata })
        .from(testEvents)
        .where(and(eq(testEvents.subjectRef, ref), eq(testEvents.hidden, false)))
        .orderBy(desc(testEvents.createdAt))
        .limit(1);
      ciBacked = latest
        ? emissionIsCiOriginated({ runId: latest.runId, metadata: latest.metadata })
        : false;
      state = ciBacked ? "verified" : "local";
    }

    clauses.push({
      clause: c,
      canonicalRef: ref,
      tests,
      state,
      ciBacked,
      countable: isCoverageCountable({ isObligation: c.isObligation, testable: c.testable }),
      daysSinceLastRun,
    });
  }

  const countable = clauses.filter((c) => c.countable);
  return {
    clauses,
    countableTotal: countable.length,
    coveredCount: countable.filter((c) => c.tests.length > 0).length,
    verifiedCount: countable.filter((c) => c.state === "verified").length,
  };
}
