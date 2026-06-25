// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import type { SpecPhase } from '@memex/shared';
import { fetchJson as fetchJsonRaw } from './fetchJson';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

// ── Spec analytics (spec-179 — the Insights page) ─────────────────────────────
// Thin typed clients over the read-only /analytics/* aggregates. Shapes mirror
// packages/server/src/services/analytics.ts + standards-graph.ts exactly.

export interface SpecsOverTimePoint {
  day: string;
  created: number;
  cumulative: number;
}

export interface SpecsByPhasePoint {
  day: string;
  draft: number;
  specify: number;
  build: number;
  verify: number;
  done: number;
}

export interface InPhaseDuration {
  phase: SpecPhase;
  n: number;
  avgDays: number;
  medianDays: number;
  maxDays: number;
}

export interface CycleTimeStats {
  n: number;
  avgDays: number | null;
  medianDays: number | null;
  p25Days: number | null;
  p75Days: number | null;
  maxDays: number | null;
  valuesDays: number[];
}

export interface PhaseDurations {
  inPhase: InPhaseDuration[];
  cycleTime: CycleTimeStats;
}

export async function fetchSpecsOverTime(): Promise<SpecsOverTimePoint[]> {
  const { points } = await fetchJsonRaw<{ points: SpecsOverTimePoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/specs-over-time`,
  );
  return points;
}

export async function fetchSpecsByPhase(): Promise<SpecsByPhasePoint[]> {
  const { points } = await fetchJsonRaw<{ points: SpecsByPhasePoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/specs-by-phase`,
  );
  return points;
}

export async function fetchPhaseDurations(): Promise<PhaseDurations> {
  return fetchJsonRaw<PhaseDurations>(fetchWithRetry, `${tBase()}/analytics/phase-durations`);
}

export interface StandardsGraphNode {
  docId: string;
  handle: string;
  title: string;
  clauseCount: number;
}

export interface StandardsGraphMentionEdge {
  sourceDocId: string;
  targetDocId: string;
  count: number;
  evidence: Array<{ clauseSeq: number | null; snippet: string | null }>;
}

export interface StandardsGraphSemanticEdge {
  sourceDocId: string;
  targetDocId: string;
  similarity: number;
}

export interface StandardsGraphData {
  nodes: StandardsGraphNode[];
  mentionEdges: StandardsGraphMentionEdge[];
  semanticEdges: StandardsGraphSemanticEdge[];
}

export async function fetchStandardsGraph(): Promise<StandardsGraphData> {
  return fetchJsonRaw<StandardsGraphData>(fetchWithRetry, `${tBase()}/analytics/standards-graph`);
}

export interface FunnelStage {
  phase: SpecPhase;
  count: number;
}

export async function fetchPipelineFunnel(): Promise<FunnelStage[]> {
  const { stages } = await fetchJsonRaw<{ stages: FunnelStage[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/pipeline-funnel`,
  );
  return stages;
}

export interface ActivityByActorPoint {
  day: string;
  human: number;
  mcp_agent: number;
  in_app_agent: number;
}

export async function fetchActivityByActor(): Promise<ActivityByActorPoint[]> {
  const { points } = await fetchJsonRaw<{ points: ActivityByActorPoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/activity-by-actor`,
  );
  return points;
}

export interface AcVerificationSummary {
  total: number;
  verified: number;
  failing: number;
  untested: number;
}

export async function fetchAcVerification(): Promise<AcVerificationSummary> {
  return fetchJsonRaw<AcVerificationSummary>(fetchWithRetry, `${tBase()}/analytics/ac-verification`);
}

export interface AcsOverTimePoint {
  day: string;
  created: number;
  verified: number;
}

export async function fetchAcsOverTime(): Promise<AcsOverTimePoint[]> {
  const { points } = await fetchJsonRaw<{ points: AcsOverTimePoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/acs-over-time`,
  );
  return points;
}

export interface TestRunVolumePoint {
  day: string;
  pass: number;
  fail: number;
  error: number;
}

export async function fetchTestRunVolume(): Promise<TestRunVolumePoint[]> {
  const { points } = await fetchJsonRaw<{ points: TestRunVolumePoint[] }>(
    fetchWithRetry,
    `${tBase()}/analytics/test-run-volume`,
  );
  return points;
}

// ── Per-spec stats (spec-406 — the Stats tab) ─────────────────────────────────
// Spec-scoped siblings of the aggregates above. Shapes mirror the new functions
// in packages/server/src/services/analytics.ts exactly. `specRef` is the spec
// handle (spec-N) or UUID — it becomes the `/analytics/spec/<ref>/…` path segment.

export interface PhaseSegment {
  phase: SpecPhase;
  start: string;
  /** null = the open current phase, running to now. */
  end: string | null;
}

export interface SpecPhaseDurations {
  segments: PhaseSegment[];
  totals: Array<{ phase: SpecPhase; days: number }>;
  hasTransitionHistory: boolean;
  fullHistory: boolean;
  caveat: string | null;
}

export async function fetchSpecPhaseDurations(specRef: string): Promise<SpecPhaseDurations> {
  return fetchJsonRaw<SpecPhaseDurations>(
    fetchWithRetry,
    `${tBase()}/analytics/spec/${encodeURIComponent(specRef)}/phase-durations`,
  );
}

export interface SpecLifecycleSummary {
  createdAt: string;
  currentPhase: SpecPhase;
  ageDays: number;
  timeInCurrentPhaseDays: number;
  tasks: { total: number; complete: number };
  acs: { total: number; verified: number; failing: number; covered: number };
}

export async function fetchSpecSummary(specRef: string): Promise<SpecLifecycleSummary> {
  return fetchJsonRaw<SpecLifecycleSummary>(
    fetchWithRetry,
    `${tBase()}/analytics/spec/${encodeURIComponent(specRef)}/summary`,
  );
}

export interface SpecTaskVelocityPoint {
  day: string;
  created: number;
  started: number;
  completed: number;
}

export interface SpecTaskVelocity {
  points: SpecTaskVelocityPoint[];
  statusBreakdown: { not_started: number; in_progress: number; complete: number };
}

export async function fetchSpecTaskVelocity(specRef: string): Promise<SpecTaskVelocity> {
  return fetchJsonRaw<SpecTaskVelocity>(
    fetchWithRetry,
    `${tBase()}/analytics/spec/${encodeURIComponent(specRef)}/task-velocity`,
  );
}

export async function fetchSpecAcVerification(specRef: string): Promise<AcVerificationSummary> {
  return fetchJsonRaw<AcVerificationSummary>(
    fetchWithRetry,
    `${tBase()}/analytics/spec/${encodeURIComponent(specRef)}/ac-verification`,
  );
}

export interface SpecActivityRow {
  at: string;
  actorName: string | null;
  channel: string | null;
  kind: string;
  action: string | null;
  narrative: string | null;
  entityId: string | null;
}

export interface SpecActivityAudit {
  rows: SpecActivityRow[];
  hasMore: boolean;
}

export async function fetchSpecActivity(
  specRef: string,
  opts: { showAll?: boolean; limit?: number; offset?: number } = {},
): Promise<SpecActivityAudit> {
  const q = new URLSearchParams();
  if (opts.showAll) q.set('showAll', '1');
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.offset != null) q.set('offset', String(opts.offset));
  const qs = q.toString();
  return fetchJsonRaw<SpecActivityAudit>(
    fetchWithRetry,
    `${tBase()}/analytics/spec/${encodeURIComponent(specRef)}/activity${qs ? `?${qs}` : ''}`,
  );
}
