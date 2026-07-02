// spec-151 dec-1 (t-7) — the clause-COVERAGE read side. Mirrors
// listAcsForBriefWithVerification (services/acs.ts) but keyed by a standard-clause ref.
//
// HONEST CEILING (the dec-2/dec-4/dec-7 reversal): a clause's green means exactly one
// thing — a test tagged to it reported pass. Memex records what a test CLAIMS; it does
// not adjudicate the claim. It cannot detect a CI run on an arbitrary forked repo, it has
// no server-side LLM to judge whether a test is sound, and it cannot compel the developer's
// agent to verify anything. So the earlier "CI-backed green", "spot vs whole-surface", and
// "adversarial-verifier pending" distinctions are gone. Three states only:
//   passing  — the latest emission for the clause passes (deriveVerificationState verified/stale).
//   failing  — the latest emission fails.
//   untested — no test tagged to the clause yet.
// A non-testable clause carries no dot at all (the UI reads `countable`).
//
// The denominator is TESTABLE OBLIGATIONS only (dec-5): non-obligations / untestable
// clauses are shown but excluded from the coverage counts.

import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  memexes,
  namespaces,
  standardClauses,
  testEventLatest,
} from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";
import { deriveVerificationState, type AcTestSnapshot } from "./acs.js";
import { isCoverageCountable } from "./testability.js";
import { facetKeysByClause } from "./facet-vocab.js";

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

// The clause coverage states. `passing` folds the old verified/stale (a green is a green —
// staleness is a tooltip detail, not a separate dot). No CI/spot/local/pending states.
export type ClauseCoverageState = "passing" | "failing" | "untested";

export interface ClauseWithVerification {
  clause: {
    id: string;
    seq: number;
    sectionId: string;
    body: string;
    isObligation: boolean | null;
    testable: boolean | null;
    archetype: string | null;
  };
  canonicalRef: string;
  tests: AcTestSnapshot[];
  state: ClauseCoverageState;
  /** Counts toward the coverage denominator (a testable obligation, dec-5). */
  countable: boolean;
  daysSinceLastRun: number | null;
  /** spec-437 dec-4 — the clause's facet verdict keys ([] = deliberate "governs nothing"),
   *  rendered as inline citation-style pills next to the clause on the standards view. */
  facetKeys: string[];
}

export interface StandardClauseCoverage {
  clauses: ClauseWithVerification[];
  /** Denominator: testable obligations only (dec-5). */
  countableTotal: number;
  /** Countable clauses with ≥1 tagged test. */
  coveredCount: number;
  /** Countable clauses whose latest emission passes. */
  passingCount: number;
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
 * Per-clause coverage + verification for a standard, plus the aggregate counts the
 * coverage rollup reads. Mirrors the AC matrix read path.
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
      sectionId: standardClauses.sectionId,
      body: standardClauses.body,
      isObligation: standardClauses.isObligation,
      testable: standardClauses.testable,
      archetype: standardClauses.archetype,
    })
    .from(standardClauses)
    .where(and(eq(standardClauses.docId, docId), ne(standardClauses.status, "deleted")))
    .orderBy(asc(standardClauses.position));
  if (clauseRows.length === 0) {
    return { clauses: [], countableTotal: 0, coveredCount: 0, passingCount: 0 };
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

  // spec-437 dec-4 — one batched read of each clause's facet verdict keys, attached to
  // its coverage row so the standards view renders facet pills inline next to the clause.
  const facetByClause = await facetKeysByClause(memexId, clauseRows.map((c) => c.id));

  const now = Date.now();
  const clauses: ClauseWithVerification[] = clauseRows.map((c) => {
    const ref = refBySeq.get(c.seq)!;
    const tests = testsByRef.get(ref) ?? [];
    const countable = isCoverageCountable({ isObligation: c.isObligation, testable: c.testable });

    const latestRunAt = tests.reduce<Date | null>(
      (acc, t) => (acc === null || t.latestRunAt > acc ? t.latestRunAt : acc),
      null,
    );
    const daysSinceLastRun =
      latestRunAt === null
        ? null
        : Math.floor((now - latestRunAt.getTime()) / (1000 * 60 * 60 * 24));

    // verified | stale → passing; failing → failing; untested → untested.
    const base = deriveVerificationState(tests, daysSinceLastRun, false);
    const state: ClauseCoverageState =
      base === "failing" ? "failing" : base === "untested" ? "untested" : "passing";

    return {
      clause: c,
      canonicalRef: ref,
      tests,
      state,
      countable,
      daysSinceLastRun,
      facetKeys: facetByClause.get(c.id) ?? [],
    };
  });

  const countableClauses = clauses.filter((c) => c.countable);
  return {
    clauses,
    countableTotal: countableClauses.length,
    coveredCount: countableClauses.filter((c) => c.tests.length > 0).length,
    passingCount: countableClauses.filter((c) => c.state === "passing").length,
  };
}
