// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

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
  phase: 'draft' | 'specify' | 'build' | 'verify' | 'done';
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
  phase: 'draft' | 'specify' | 'build' | 'verify' | 'done';
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
