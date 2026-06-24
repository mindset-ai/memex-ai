// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { fetchWithRetry } from './http';
import { tBase } from './internal';

export type AcKind = 'scope' | 'implementation';
export type AcStatus = 'proposed' | 'active' | 'rejected' | 'superseded';
// spec-188 dec-1: 'accepted' is the audited human override for ACs that can't
// be exercised by a digital test — own visual identity, counts toward the
// verified percentage.
export type AcVerificationState =
  | 'verified'
  | 'failing'
  | 'untested'
  | 'stale'
  | 'accepted';

export interface AcTestSnapshot {
  testIdentifier: string | null;
  latestStatus: 'pass' | 'fail' | 'error';
  /** ISO string from JSON; convert at the call site if you need Date. */
  latestRunAt: string;
  runCount: number;
}

export interface AcWithVerification {
  ac: {
    id: string;
    memexId: string;
    briefId: string;
    seq: number;
    kind: AcKind;
    statement: string;
    status: AcStatus;
    /** spec-188: manual-acceptance provenance — display snapshot of who
     *  accepted (user.name ?? email). Null when not accepted. */
    acceptedBy: string | null;
    /** ISO timestamp of the acceptance; null when not accepted. Note the
     *  acceptance is an overlay — verificationState may read 'failing' while
     *  these stay set (evidence wins, dec-2). */
    acceptedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  canonicalRef: string;
  tests: AcTestSnapshot[];
  verificationState: AcVerificationState;
  daysSinceLastRun: number | null;
  /** Polymorphic parent links — used by the Decisions tab strip to filter
   *  ACs whose parents include a given decisionId. Empty array means the AC
   *  has no recorded parent. */
  // Wire-format discriminator: the server sends the DB `parent_kind` value,
  // which stays 'brief' (see services/acs.ts ParentKind). Not the product noun.
  parents: Array<{ kind: 'brief' | 'decision'; id: string }>;
}

export interface AcAlignmentDay {
  date: string;
  kind: AcKind;
  verified: number;
  total: number;
}

export async function fetchAcsForBrief(
  docId: string,
): Promise<AcWithVerification[]> {
  const res = await fetchWithRetry(`${tBase()}/acs/doc/${docId}`);
  if (!res.ok) throw new Error(`Failed to fetch ACs: ${res.status}`);
  return res.json();
}

// spec-188: manual verification acceptance — POST records, DELETE revokes.
// Server derives the actor from the session; no body needed.
export async function acceptAc(acId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/acs/${acId}/acceptance`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to accept AC: ${res.status}`);
}

export async function unacceptAc(acId: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/acs/${acId}/acceptance`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to un-accept AC: ${res.status}`);
}

export async function fetchAcAlignmentHistory(
  docId: string,
  days = 30,
): Promise<AcAlignmentDay[]> {
  const res = await fetchWithRetry(
    `${tBase()}/acs/doc/${docId}/alignment-history?days=${days}`,
  );
  if (!res.ok)
    throw new Error(`Failed to fetch AC alignment history: ${res.status}`);
  return res.json();
}

// ── b-96: per-AC test-event matrix ─────────────────────────────────────────

export type TestEventStatus = 'pass' | 'fail' | 'error';

export interface TestMatrixEmission {
  status: TestEventStatus;
  /** ISO timestamp emitted by the server. */
  emittedAt: string;
  /**
   * Actor — WHO ran the test (spec-115 dec-6, spec-122 activity contract).
   * Top-level sibling of metadata. Null when the emission did not include
   * actor.
   */
  actor?: string | null;
  /**
   * Extensible metadata bag (spec-115 v0.1.0). Surfaced in the AC matrix
   * tooltip on hover. Null/undefined when the emitting test did not pass
   * metadata (the common case for pre-v0.1.0 emissions).
   */
  metadata?: Record<string, string> | null;
}

export interface AcTestMatrixRow {
  /** test_identifier as emitted by the helper; empty string when the
   *  source row had a NULL test_identifier (legacy / hand-rolled emit). */
  testIdentifier: string;
  /** Every emission ever recorded for this (acUid, testIdentifier),
   *  newest-first. Per b-96 dec-11: one entry per emission, no run-batching. */
  emissions: TestMatrixEmission[];
}

export async function fetchAcTestMatrix(
  acId: string,
): Promise<AcTestMatrixRow[]> {
  const res = await fetchWithRetry(`${tBase()}/acs/${acId}/test-matrix`);
  if (!res.ok) throw new Error(`Failed to fetch AC test matrix: ${res.status}`);
  return res.json();
}

/**
 * Discontinue every emission for `(acId, testIdentifier)`. Hard-delete; per
 * b-96 dec-14 no audit record is written. Returns the number of rows removed.
 */
export async function discontinueAcTestEvents(
  acId: string,
  testIdentifier: string,
): Promise<{ deleted: number }> {
  const url = `${tBase()}/acs/${acId}/test-events?test_identifier=${encodeURIComponent(testIdentifier)}`;
  const res = await fetchWithRetry(url, { method: 'DELETE' });
  if (!res.ok)
    throw new Error(`Failed to discontinue test events: ${res.status}`);
  return res.json();
}
