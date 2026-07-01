// spec-151 t-7 — client for the Standard clause-coverage read. Mirrors api/acs.ts
// (tBase() tenant-scoped path + fetchWithRetry), keyed by the standard's docId.

import { fetchWithRetry } from './http';
import { tBase } from './internal';

// The honest ceiling (dec-2/dec-4/dec-7 reversal): a clause's green means a tagged test
// reported pass — no CI-provenance, surface, or verifier distinction. Three states only;
// a non-testable clause carries no dot at all (read `countable`).
export type ClauseCoverageState = 'passing' | 'failing' | 'untested';

export interface ClauseTestSnapshot {
  testIdentifier: string | null;
  latestStatus: 'pass' | 'fail' | 'error';
  latestRunAt: string;
  runCount: number;
}

export interface ClauseWithVerification {
  clause: {
    id: string;
    seq: number;
    /** Owning section — the standard renders its clauses grouped under each section. */
    sectionId: string;
    body: string;
    isObligation: boolean | null;
    testable: boolean | null;
    archetype: string | null;
  };
  canonicalRef: string;
  tests: ClauseTestSnapshot[];
  state: ClauseCoverageState;
  /** A testable obligation — only these carry a status dot and count toward coverage. */
  countable: boolean;
  daysSinceLastRun: number | null;
  /** spec-437 dec-4 — the clause's facet verdict keys ([] = deliberate "governs nothing"),
   *  rendered as inline citation-style pills after the clause text. */
  facetKeys: string[];
}

export interface StandardClauseCoverage {
  clauses: ClauseWithVerification[];
  /** Denominator: testable obligations only. */
  countableTotal: number;
  coveredCount: number;
  passingCount: number;
}

export async function fetchClauseCoverage(
  docId: string,
): Promise<StandardClauseCoverage> {
  const res = await fetchWithRetry(`${tBase()}/standards/doc/${docId}/clause-coverage`);
  if (!res.ok) throw new Error(`Failed to fetch clause coverage: ${res.status}`);
  return res.json();
}
