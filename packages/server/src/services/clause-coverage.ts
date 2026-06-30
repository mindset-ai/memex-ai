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

// The clause coverage states, in honesty order:
//   verified — CI-backed green from a WHOLE-SURFACE test (the honest universal green).
//   spot     — passing but the attestation declared itself a spot/sampled check, so it
//              must NOT read as universal coverage even if CI-backed (dec-2 / ac-8).
//   local    — passing but the latest emission lacks CI provenance (dec-4 / ac-12).
//   failing / stale / untested — as for ACs.
export type ClauseCoverageState =
  | "verified"
  | "spot"
  | "local"
  | "failing"
  | "stale"
  | "untested";

// Metadata keys carrying the universal-coverage disclosure (dec-2). The emit helper
// passes options.metadata through verbatim, so recording these needs no migration.
export const SURFACE_META_KEY = "clause_surface";
export const KIND_META_KEY = "clause_kind";
// A surface value that asserts the test swept the WHOLE applicable surface. Anything
// else (spot / sampled / a free-text scope, or absent) is treated as non-universal.
const WHOLE_SURFACE = "whole-surface";

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
  /** The swept surface the latest attestation declared (dec-2); null if undeclared. */
  sweptSurface: string | null;
  /** The check-kind / archetype the latest attestation declared (dec-2); null if undeclared. */
  checkKind: string | null;
  /** The latest passing attestation declared itself whole-surface (earns universal green). */
  wholeSurface: boolean;
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
    let sweptSurface: string | null = null;
    let checkKind: string | null = null;
    let wholeSurface = false;
    let state: ClauseCoverageState;

    if (base === "failing" || base === "untested") {
      state = base;
    } else {
      // base === "verified" | "stale": read the latest non-hidden emission once to
      // recover BOTH its CI provenance (dec-4) and its declared surface/kind (dec-2).
      const [latest] = await db
        .select({ runId: testEvents.runId, metadata: testEvents.metadata })
        .from(testEvents)
        .where(and(eq(testEvents.subjectRef, ref), eq(testEvents.hidden, false)))
        .orderBy(desc(testEvents.createdAt))
        .limit(1);
      const md = latest?.metadata ?? {};
      sweptSurface = typeof md[SURFACE_META_KEY] === "string" ? md[SURFACE_META_KEY]! : null;
      checkKind = typeof md[KIND_META_KEY] === "string" ? md[KIND_META_KEY]! : null;
      wholeSurface = sweptSurface === WHOLE_SURFACE;
      ciBacked = latest
        ? emissionIsCiOriginated({ runId: latest.runId, metadata: latest.metadata })
        : false;

      if (base === "stale") {
        state = "stale";
      } else if (!ciBacked) {
        // Passing but no CI provenance → local-only, whatever the surface (dec-4).
        state = "local";
      } else if (!wholeSurface) {
        // CI-backed green but NOT a declared whole-surface sweep → spot. A spot (or
        // undeclared-surface) attestation never wears the universal "verified" badge
        // (dec-2 / ac-3 / ac-8): a green must not silently overstate universal coverage.
        state = "spot";
      } else {
        state = "verified";
      }
    }

    clauses.push({
      clause: c,
      canonicalRef: ref,
      tests,
      state,
      ciBacked,
      sweptSurface,
      checkKind,
      wholeSurface,
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
