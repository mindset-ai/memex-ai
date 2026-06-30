// spec-151 t-7 — client for the Standard clause-coverage view. Mirrors api/acs.ts
// (tBase() tenant-scoped path + fetchWithRetry), keyed by the standard's docId.

import { fetchWithRetry } from './http';
import { tBase } from './internal';

// "verified" = CI-backed whole-surface green; "spot" = passing but a spot/sampled
// (non-universal) check (dec-2); "local" = passing but not CI-backed (dec-4).
export type ClauseCoverageState =
  | 'verified'
  | 'spot'
  | 'local'
  | 'failing'
  | 'stale'
  // pending — has a test, but no independent verifier has confirmed it yet (dec-7).
  | 'pending'
  | 'untested';

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
    body: string;
    isObligation: boolean | null;
    testable: boolean | null;
    archetype: string | null;
  };
  canonicalRef: string;
  tests: ClauseTestSnapshot[];
  state: ClauseCoverageState;
  ciBacked: boolean;
  sweptSurface: string | null;
  checkKind: string | null;
  wholeSurface: boolean;
  countable: boolean;
  daysSinceLastRun: number | null;
}

export interface StandardClauseCoverage {
  clauses: ClauseWithVerification[];
  /** Denominator: testable obligations only. */
  countableTotal: number;
  coveredCount: number;
  verifiedCount: number;
}

export async function fetchClauseCoverage(
  docId: string,
): Promise<StandardClauseCoverage> {
  const res = await fetchWithRetry(`${tBase()}/standards/doc/${docId}/clause-coverage`);
  if (!res.ok) throw new Error(`Failed to fetch clause coverage: ${res.status}`);
  return res.json();
}
