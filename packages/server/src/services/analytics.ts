// Spec analytics aggregates (spec-179) — the read side of the Insights page.
//
// Every function is memex-scoped and aggregates in SQL (GROUP BY day/status,
// percentile_cont for medians) so the browser receives chart-shaped series,
// never raw document rows. These are reads — std-8's mutate() contract does
// not apply. Tenancy: callers pass a memexId that memexResolver + session
// middleware already authorized (std-7: outsiders 404 upstream).
//
// Phase vocabulary: spec rows carry the renamed lifecycle (draft / specify /
// build / verify / done — dec-3 of doc-10). Legacy values can't appear on
// docType='spec' rows post-rename, but the CASE normalisation below keeps the
// aggregates correct even if a stray legacy row survives.

import { PHASE_ORDER } from "@memex/shared";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

// spec-355 dry-2: the canonical ordered phase array, re-exported as SPEC_PHASES
// so existing call sites are untouched.
export const SPEC_PHASES = PHASE_ORDER;
export type SpecPhase = (typeof SPEC_PHASES)[number];

// Normalise a documents.status value onto the spec lifecycle. Mirrors the
// rename mapping (review→specify, implementation→build, approved→done).
const PHASE_CASE = sql.raw(`
  CASE status
    WHEN 'review' THEN 'specify'
    WHEN 'implementation' THEN 'build'
    WHEN 'approved' THEN 'done'
    ELSE status
  END
`);

export interface SpecsOverTimePoint {
  /** ISO date (YYYY-MM-DD). Gapless — every day from first spec to today. */
  day: string;
  created: number;
  cumulative: number;
}

/**
 * Per-day created counts + running total for docType='spec' rows, gapless from
 * the first spec's creation date through today (charts want continuous axes).
 * Archived specs count — they were created, and "specs over time" is a record
 * of intake, not of survival.
 */
export async function specsOverTime(memexId: string): Promise<SpecsOverTimePoint[]> {
  const rows = (await db.execute(sql`
    WITH per_day AS (
      SELECT created_at::date AS day, count(*)::int AS created
      FROM documents
      WHERE memex_id = ${memexId} AND doc_type = 'spec'
      GROUP BY 1
    ),
    days AS (
      SELECT generate_series(
        (SELECT min(day) FROM per_day),
        CURRENT_DATE,
        interval '1 day'
      )::date AS day
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS day,
      COALESCE(per_day.created, 0)::int AS created,
      (sum(COALESCE(per_day.created, 0)) OVER (ORDER BY days.day))::int AS cumulative
    FROM days
    LEFT JOIN per_day ON per_day.day = days.day
    ORDER BY days.day
  `)) as unknown as SpecsOverTimePoint[];
  return rows;
}

export interface SpecsByPhasePoint {
  day: string;
  draft: number;
  specify: number;
  build: number;
  verify: number;
  done: number;
}

/**
 * Cumulative spec counts per CURRENT phase, keyed by creation date — the
 * stacked-area series. Until status_changed history (ac-5) accumulates this is
 * an as-of-today projection, not a historical reconstruction; the UI carries
 * that caveat (Design section of spec-179).
 */
export async function specsByPhase(memexId: string): Promise<SpecsByPhasePoint[]> {
  const rows = (await db.execute(sql`
    WITH per_day AS (
      SELECT created_at::date AS day, ${PHASE_CASE} AS phase, count(*)::int AS created
      FROM documents
      WHERE memex_id = ${memexId} AND doc_type = 'spec'
      GROUP BY 1, 2
    ),
    days AS (
      SELECT generate_series(
        (SELECT min(day) FROM per_day),
        CURRENT_DATE,
        interval '1 day'
      )::date AS day
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS day,
      (sum(COALESCE(CASE WHEN per_day.phase = 'draft'  THEN per_day.created END, 0)) OVER w)::int AS draft,
      (sum(COALESCE(CASE WHEN per_day.phase = 'specify'   THEN per_day.created END, 0)) OVER w)::int AS specify,
      (sum(COALESCE(CASE WHEN per_day.phase = 'build'  THEN per_day.created END, 0)) OVER w)::int AS build,
      (sum(COALESCE(CASE WHEN per_day.phase = 'verify' THEN per_day.created END, 0)) OVER w)::int AS verify,
      (sum(COALESCE(CASE WHEN per_day.phase = 'done'   THEN per_day.created END, 0)) OVER w)::int AS done
    FROM days
    LEFT JOIN per_day ON per_day.day = days.day
    WINDOW w AS (ORDER BY days.day)
    ORDER BY days.day
  `)) as unknown as SpecsByPhasePoint[];
  return rows;
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
  /** Exact draft→done durations in days, one per completed spec (UI bins them). */
  valuesDays: number[];
}

export interface PhaseDurations {
  inPhase: InPhaseDuration[];
  cycleTime: CycleTimeStats;
}

/**
 * Two exact measures (per spec-179 s-2):
 *  - inPhase: how long active (non-archived) specs have been sitting in their
 *    current phase — right-censored, clocks still running.
 *  - cycleTime: created→done duration for specs whose current status is done
 *    (statusChangedAt records the transition into done).
 */
export async function phaseDurations(memexId: string): Promise<PhaseDurations> {
  const inPhaseRows = (await db.execute(sql`
    SELECT
      ${PHASE_CASE} AS phase,
      count(*)::int AS n,
      round((avg(EXTRACT(EPOCH FROM now() - status_changed_at)) / 86400)::numeric, 1)::float AS "avgDays",
      round(((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM now() - status_changed_at))) / 86400)::numeric, 1)::float AS "medianDays",
      round((max(EXTRACT(EPOCH FROM now() - status_changed_at)) / 86400)::numeric, 1)::float AS "maxDays"
    FROM documents
    WHERE memex_id = ${memexId} AND doc_type = 'spec' AND archived_at IS NULL
    GROUP BY 1
  `)) as unknown as InPhaseDuration[];

  // Stable phase order for the UI; phases with no specs are simply absent.
  const order = new Map(SPEC_PHASES.map((p, i) => [p, i]));
  const inPhase = inPhaseRows
    .filter((r) => order.has(r.phase))
    .sort((a, b) => (order.get(a.phase) ?? 99) - (order.get(b.phase) ?? 99));

  const cycleRows = (await db.execute(sql`
    SELECT round((EXTRACT(EPOCH FROM status_changed_at - created_at) / 86400)::numeric, 2)::float AS days
    FROM documents
    WHERE memex_id = ${memexId} AND doc_type = 'spec' AND ${PHASE_CASE} = 'done'
    ORDER BY 1
  `)) as unknown as Array<{ days: number }>;

  const valuesDays = cycleRows.map((r) => r.days);
  const n = valuesDays.length;
  const quantile = (q: number): number | null => {
    if (n === 0) return null;
    const pos = (n - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const v = valuesDays[lo] + (valuesDays[hi] - valuesDays[lo]) * (pos - lo);
    return Math.round(v * 10) / 10;
  };

  return {
    inPhase,
    cycleTime: {
      n,
      avgDays: n ? Math.round((valuesDays.reduce((a, b) => a + b, 0) / n) * 10) / 10 : null,
      medianDays: quantile(0.5),
      p25Days: quantile(0.25),
      p75Days: quantile(0.75),
      maxDays: n ? valuesDays[n - 1] : null,
      valuesDays,
    },
  };
}

// ── Pipeline funnel (spec-179 follow-on charts) ──────────────────────────────

export interface FunnelStage {
  phase: SpecPhase;
  /** Specs currently at or beyond this phase. */
  count: number;
}

/**
 * "Where does work pile up?" — for each lifecycle phase, how many specs are
 * currently AT or BEYOND it. draft = every spec; done = completed only.
 * Until status_changed history (ac-5) deepens, current status is the proxy
 * for "reached" — a spec in build has by definition reached draft/specify/build.
 * Archived specs are excluded: an abandoned draft isn't pipeline progress.
 */
export async function pipelineFunnel(memexId: string): Promise<FunnelStage[]> {
  const rows = (await db.execute(sql`
    SELECT ${PHASE_CASE} AS phase, count(*)::int AS n
    FROM documents
    WHERE memex_id = ${memexId} AND doc_type = 'spec' AND archived_at IS NULL
    GROUP BY 1
  `)) as unknown as Array<{ phase: SpecPhase; n: number }>;
  const byPhase = new Map(rows.map((r) => [r.phase, r.n]));
  return SPEC_PHASES.map((phase, i) => ({
    phase,
    count: SPEC_PHASES.slice(i).reduce((sum, p) => sum + (byPhase.get(p) ?? 0), 0),
  }));
}

// ── Activity by actor kind (spec-179 follow-on charts) ──────────────────────

export const ACTOR_KINDS = ["human", "mcp_agent", "in_app_agent"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface ActivityByActorPoint {
  day: string;
  human: number;
  mcp_agent: number;
  in_app_agent: number;
}

/**
 * "Who is doing the work?" — per-day activity_log rows split by actor kind,
 * gapless from the first row to today. Three exclusions keep this a measure of
 * WORK rather than noise: `viewed` rows (reads, dominated by page loads),
 * `test_event` rows (one per test invocation — a single CI run would dwarf a
 * week of authoring), and `system` actors (TTL sweeps and unattributed server
 * writes — plumbing, not anyone's work; it routinely dwarfs the human/agent
 * signal this chart exists to show).
 */
export async function activityByActor(memexId: string): Promise<ActivityByActorPoint[]> {
  const rows = (await db.execute(sql`
    WITH per_day AS (
      SELECT created_at::date AS day, actor_kind, count(*)::int AS n
      FROM activity_log
      WHERE memex_id = ${memexId}
        AND action <> 'viewed'
        AND entity <> 'test_event'
        AND actor_kind <> 'system'
      GROUP BY 1, 2
    ),
    days AS (
      SELECT generate_series(
        (SELECT min(day) FROM per_day),
        CURRENT_DATE,
        interval '1 day'
      )::date AS day
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS day,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.actor_kind = 'human'), 0)::int AS human,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.actor_kind = 'mcp_agent'), 0)::int AS mcp_agent,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.actor_kind = 'in_app_agent'), 0)::int AS in_app_agent
    FROM days
    LEFT JOIN per_day ON per_day.day = days.day
    GROUP BY days.day
    ORDER BY days.day
  `)) as unknown as ActivityByActorPoint[];
  return rows;
}

// ── AC verification health (spec-179 follow-on charts) ──────────────────────

export interface AcVerificationSummary {
  /** Active ACs across the memex's specs. */
  total: number;
  /** ACs whose latest emissions are all green (≥1 pass, no fail/error). */
  verified: number;
  /** ACs with a fail/error among their latest emissions. */
  failing: number;
  /** ACs with no emissions at all — invisible to verification. */
  untested: number;
}

/**
 * "Is the work proven?" — rolls test_event_latest (latest status per (ac,
 * test)) up to per-AC verdicts, then to one memex-wide summary. subject_ref is the
 * canonical ref string, so the memex's rows are prefix-matched on its
 * `<namespace>/<memex>/` slug pair.
 */
export async function acVerification(memexId: string): Promise<AcVerificationSummary> {
  const [slugs] = (await db.execute(sql`
    SELECT n.slug AS ns, m.slug AS mx
    FROM memexes m JOIN namespaces n ON n.id = m.namespace_id
    WHERE m.id = ${memexId}
  `)) as unknown as Array<{ ns: string; mx: string }>;
  if (!slugs) return { total: 0, verified: 0, failing: 0, untested: 0 };

  const [{ total }] = (await db.execute(sql`
    SELECT count(*)::int AS total
    FROM acs
    WHERE memex_id = ${memexId} AND status = 'active'
  `)) as unknown as Array<{ total: number }>;

  const prefix = `${slugs.ns}/${slugs.mx}/`;
  const rollup = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE has_fail)::int AS failing,
      count(*) FILTER (WHERE NOT has_fail AND has_pass)::int AS verified
    FROM (
      SELECT
        subject_ref,
        bool_or(latest_status IN ('fail', 'error')) AS has_fail,
        bool_or(latest_status = 'pass') AS has_pass
      FROM test_event_latest
      WHERE subject_ref LIKE ${prefix + "%"}
      GROUP BY subject_ref
    ) per_ac
  `)) as unknown as Array<{ failing: number; verified: number }>;

  const { failing, verified } = rollup[0] ?? { failing: 0, verified: 0 };
  return {
    total,
    verified,
    failing,
    untested: Math.max(0, total - verified - failing),
  };
}

// ── ACs created vs verified over time (spec-179 follow-on charts) ───────────

export interface AcsOverTimePoint {
  day: string;
  /** Cumulative active ACs created by end of this day. */
  created: number;
  /** Cumulative ACs whose FIRST passing emission landed by end of this day. */
  verified: number;
}

/**
 * "Is verification keeping up with intent?" — two cumulative lines: ACs
 * created (the commitments) vs ACs first-verified by a passing test emission
 * (the proof). The vertical gap is the verification debt. Verified counts come
 * from test_events (first non-hidden pass per subject_ref, prefix-scoped to this
 * memex); they can lag created by design and can never exceed reality —
 * emissions for since-deleted ACs are a tolerable over-count noted here.
 */
export async function acsOverTime(memexId: string): Promise<AcsOverTimePoint[]> {
  const [slugs] = (await db.execute(sql`
    SELECT n.slug AS ns, m.slug AS mx
    FROM memexes m JOIN namespaces n ON n.id = m.namespace_id
    WHERE m.id = ${memexId}
  `)) as unknown as Array<{ ns: string; mx: string }>;
  if (!slugs) return [];
  const prefix = `${slugs.ns}/${slugs.mx}/`;

  const rows = (await db.execute(sql`
    WITH created_per_day AS (
      SELECT created_at::date AS day, count(*)::int AS n
      FROM acs
      WHERE memex_id = ${memexId} AND status = 'active'
      GROUP BY 1
    ),
    -- spec-398 t-6: read the FIRST pass from the durable ac_first_verified
    -- snapshot, not min(created_at) over test_events — keep-last-10 retention
    -- deletes the oldest passing row, so the operational log can no longer answer
    -- "when did this AC first go green". One row per subject_ref already, so no min().
    first_pass AS (
      SELECT subject_ref, first_verified_at::date AS day
      FROM ac_first_verified
      WHERE subject_ref LIKE ${prefix + "%"}
    ),
    verified_per_day AS (
      SELECT day, count(*)::int AS n FROM first_pass GROUP BY 1
    ),
    days AS (
      SELECT generate_series(
        LEAST(
          (SELECT min(day) FROM created_per_day),
          (SELECT coalesce(min(day), CURRENT_DATE) FROM verified_per_day)
        ),
        CURRENT_DATE,
        interval '1 day'
      )::date AS day
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS day,
      (sum(COALESCE(c.n, 0)) OVER w)::int AS created,
      (sum(COALESCE(v.n, 0)) OVER w)::int AS verified
    FROM days
    LEFT JOIN created_per_day c ON c.day = days.day
    LEFT JOIN verified_per_day v ON v.day = days.day
    WINDOW w AS (ORDER BY days.day)
    ORDER BY days.day
  `)) as unknown as AcsOverTimePoint[];
  return rows;
}

// ── Test-run volume (spec-179 follow-on charts) ──────────────────────────────

export interface TestRunVolumePoint {
  day: string;
  pass: number;
  fail: number;
  error: number;
}

/**
 * "How hard is the verification loop running?" — raw test emissions per day
 * split by status, prefix-scoped to this memex's subject_refs. Hidden emissions
 * count: they're real runs (volume), they're only excluded from the
 * verification badge. Gapless from the first emission to today.
 */
export async function testRunVolume(memexId: string): Promise<TestRunVolumePoint[]> {
  const [slugs] = (await db.execute(sql`
    SELECT n.slug AS ns, m.slug AS mx
    FROM memexes m JOIN namespaces n ON n.id = m.namespace_id
    WHERE m.id = ${memexId}
  `)) as unknown as Array<{ ns: string; mx: string }>;
  if (!slugs) return [];
  const prefix = `${slugs.ns}/${slugs.mx}/`;

  const rows = (await db.execute(sql`
    WITH per_day AS (
      SELECT created_at::date AS day, status, count(*)::int AS n
      FROM test_events
      WHERE subject_ref LIKE ${prefix + "%"}
      GROUP BY 1, 2
    ),
    days AS (
      SELECT generate_series(
        (SELECT min(day) FROM per_day),
        CURRENT_DATE,
        interval '1 day'
      )::date AS day
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS day,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.status = 'pass'), 0)::int AS pass,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.status = 'fail'), 0)::int AS fail,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.status = 'error'), 0)::int AS error
    FROM days
    LEFT JOIN per_day ON per_day.day = days.day
    GROUP BY days.day
    ORDER BY days.day
  `)) as unknown as TestRunVolumePoint[];
  return rows;
}

// ── Test-signal pulse (Pulse test-signal monitor) ────────────────────────────

/** One minute-bucket of test-emission volume, split by outcome. */
export interface TestSignalBucket {
  /** ISO-8601 UTC start of the minute bucket (e.g. "2026-06-11T12:03:00Z"). */
  at: string;
  pass: number;
  fail: number;
  error: number;
}

export interface TestSignalPulse {
  /** The rolling window, in minutes, the buckets cover (ending now). */
  windowMinutes: number;
  /** Gapless minute buckets, oldest→newest, exactly `windowMinutes` of them. */
  buckets: TestSignalBucket[];
  /** Window totals, for the headline counter + green%. */
  totals: { pass: number; fail: number; error: number; total: number };
}

const PULSE_DEFAULT_WINDOW_MIN = 60;
const PULSE_MAX_WINDOW_MIN = 240;

/**
 * "Are test signals flowing right now?" — minute-bucketed emission volume over a
 * short rolling window, split pass/fail/error, prefix-scoped to this memex's
 * subject_refs (the memex is encoded in every subject_ref; no test_events.memex_id column
 * needed). Powers the Pulse test-signal monitor's historical baseline; the live
 * SSE `test_event.created` stream increments the current bucket on top of this.
 *
 * Hidden emissions COUNT toward volume (they're real runs) — mirrors
 * `testRunVolume`. The window is gapless (every minute present, zero-filled) so
 * the sparkline has a stable x-axis. Capped at PULSE_MAX_WINDOW_MIN.
 */
export async function testSignalPulse(
  memexId: string,
  opts: { windowMinutes?: number } = {},
): Promise<TestSignalPulse> {
  const windowMinutes = Math.max(
    1,
    Math.min(PULSE_MAX_WINDOW_MIN, Math.floor(opts.windowMinutes ?? PULSE_DEFAULT_WINDOW_MIN)),
  );

  const [slugs] = (await db.execute(sql`
    SELECT n.slug AS ns, m.slug AS mx
    FROM memexes m JOIN namespaces n ON n.id = m.namespace_id
    WHERE m.id = ${memexId}
  `)) as unknown as Array<{ ns: string; mx: string }>;
  if (!slugs) {
    return { windowMinutes, buckets: [], totals: { pass: 0, fail: 0, error: 0, total: 0 } };
  }
  const prefix = `${slugs.ns}/${slugs.mx}/`;

  const buckets = (await db.execute(sql`
    WITH per_bucket AS (
      SELECT date_trunc('minute', created_at) AS bucket, status, count(*)::int AS n
      FROM test_events
      WHERE subject_ref LIKE ${prefix + "%"}
        AND created_at >= now() - make_interval(mins => ${windowMinutes})
      GROUP BY 1, 2
    ),
    grid AS (
      SELECT generate_series(
        date_trunc('minute', now()) - make_interval(mins => ${windowMinutes - 1}),
        date_trunc('minute', now()),
        interval '1 minute'
      ) AS bucket
    )
    SELECT
      to_char(grid.bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
      COALESCE(sum(per_bucket.n) FILTER (WHERE per_bucket.status = 'pass'), 0)::int AS pass,
      COALESCE(sum(per_bucket.n) FILTER (WHERE per_bucket.status = 'fail'), 0)::int AS fail,
      COALESCE(sum(per_bucket.n) FILTER (WHERE per_bucket.status = 'error'), 0)::int AS error
    FROM grid
    LEFT JOIN per_bucket ON per_bucket.bucket = grid.bucket
    GROUP BY grid.bucket
    ORDER BY grid.bucket
  `)) as unknown as TestSignalBucket[];

  const totals = buckets.reduce(
    (acc, b) => {
      acc.pass += b.pass;
      acc.fail += b.fail;
      acc.error += b.error;
      acc.total += b.pass + b.fail + b.error;
      return acc;
    },
    { pass: 0, fail: 0, error: 0, total: 0 },
  );

  return { windowMinutes, buckets, totals };
}

// ── Per-spec stats (spec-406) ────────────────────────────────────────────────
//
// The spec-scoped siblings of the memex-wide aggregates above. Each takes
// (memexId, docId) and powers one surface of the per-Spec Stats tab. Same
// discipline: aggregate in SQL, return chart-shaped data, never raw rows.
// dec-2: these live alongside the memex-scoped functions and reuse SPEC_PHASES.

/** Normalise a raw documents.status onto the lifecycle enum (JS sibling of PHASE_CASE). */
const PHASE_NORMALIZE: Record<string, SpecPhase> = {
  review: "specify",
  implementation: "build",
  approved: "done",
};
function normalizePhase(status: string): SpecPhase {
  return (PHASE_NORMALIZE[status] ?? status) as SpecPhase;
}

/** Look up `<namespace>/<memex>/specs/<handle>/acs/` — the subject_ref prefix for ONE spec. */
async function specAcUidPrefix(memexId: string, docId: string): Promise<string | null> {
  const [row] = (await db.execute(sql`
    SELECT n.slug AS ns, m.slug AS mx, d.handle AS handle
    FROM documents d
    JOIN memexes m ON m.id = d.memex_id
    JOIN namespaces n ON n.id = m.namespace_id
    WHERE d.id = ${docId} AND d.memex_id = ${memexId}
  `)) as unknown as Array<{ ns: string; mx: string; handle: string }>;
  if (!row) return null;
  return `${row.ns}/${row.mx}/specs/${row.handle}/acs/`;
}

export interface PhaseSegment {
  phase: SpecPhase;
  /** ISO start of this visit to the phase. */
  start: string;
  /** ISO end, or null when this is the open current phase (runs to now). */
  end: string | null;
}

export interface SpecPhaseDurations {
  /** Each visit to a phase, in chronological order — re-entries are separate segments (dec-4). */
  segments: PhaseSegment[];
  /** Total days per phase, re-entries summed, in lifecycle order (dec-1). */
  totals: Array<{ phase: SpecPhase; days: number }>;
  /** False when no status_changed events exist (pre-emission spec) — the UI shows a caveat band. */
  hasTransitionHistory: boolean;
  /** True only when the recorded history reaches back to draft; else early phases are compressed. */
  fullHistory: boolean;
  /** Human caveat when history is partial/absent, else null. */
  caveat: string | null;
}

const DAY_MS = 86_400_000;
const toDays = (ms: number) => Math.round((ms / DAY_MS) * 100) / 100;

/**
 * Per-spec time-in-phase from the `activity_log` status_changed event series
 * (dec-1). Orders transitions, seeds the first interval from the doc's
 * created_at, pairs consecutive transitions into segments, and SUMS per phase so
 * a re-entered phase (verify→build→verify) counts every visit. The open current
 * phase runs to now(). A spec with no recorded transitions falls back to
 * status_changed_at with a caveat — never a fabricated boundary.
 */
export async function specPhaseDurations(memexId: string, docId: string): Promise<SpecPhaseDurations> {
  const [doc] = (await db.execute(sql`
    SELECT created_at AS "createdAt", status, status_changed_at AS "statusChangedAt"
    FROM documents WHERE id = ${docId} AND memex_id = ${memexId}
  `)) as unknown as Array<{ createdAt: string; status: string; statusChangedAt: string }>;
  if (!doc) {
    return { segments: [], totals: [], hasTransitionHistory: false, fullHistory: false, caveat: null };
  }

  const events = (await db.execute(sql`
    SELECT created_at AS at, payload->>'from' AS "from", payload->>'to' AS "to"
    FROM activity_log
    WHERE action = 'status_changed'
      AND memex_id = ${memexId}
      AND (payload->>'doc_id') = ${docId}
    ORDER BY created_at ASC
  `)) as unknown as Array<{ at: string; from: string | null; to: string | null }>;

  const now = Date.now();
  const createdAt = new Date(doc.createdAt);
  const currentPhase = normalizePhase(doc.status);
  const segments: PhaseSegment[] = [];

  if (events.length === 0) {
    // Pre-emission spec: no recorded transitions. Honest fallback — show only the
    // current phase from its last-known entry (status_changed_at) to now, caveated.
    const start = new Date(doc.statusChangedAt ?? doc.createdAt);
    segments.push({ phase: currentPhase, start: start.toISOString(), end: null });
    const totals = [{ phase: currentPhase, days: toDays(now - start.getTime()) }];
    return {
      segments,
      totals,
      hasTransitionHistory: false,
      fullHistory: false,
      caveat: "No recorded phase transitions for this spec — only the current phase is shown.",
    };
  }

  // Seed the first interval from creation → first transition, attributed to the
  // phase the first transition moved OUT of (dec-1).
  const firstFrom = normalizePhase(events[0].from ?? currentPhase);
  segments.push({ phase: firstFrom, start: createdAt.toISOString(), end: new Date(events[0].at).toISOString() });
  for (let i = 0; i < events.length; i++) {
    const to = normalizePhase(events[i].to ?? currentPhase);
    const start = new Date(events[i].at);
    const end = i + 1 < events.length ? new Date(events[i + 1].at) : null;
    segments.push({ phase: to, start: start.toISOString(), end: end ? end.toISOString() : null });
  }

  // Sum per phase (re-entry aware), then order by the lifecycle.
  const sums = new Map<SpecPhase, number>();
  for (const s of segments) {
    const endMs = s.end ? new Date(s.end).getTime() : now;
    sums.set(s.phase, (sums.get(s.phase) ?? 0) + (endMs - new Date(s.start).getTime()));
  }
  const order = new Map(SPEC_PHASES.map((p, i) => [p, i]));
  const totals = [...sums.entries()]
    .map(([phase, ms]) => ({ phase, days: toDays(ms) }))
    .sort((a, b) => (order.get(a.phase) ?? 99) - (order.get(b.phase) ?? 99));

  const fullHistory = firstFrom === "draft";
  return {
    segments,
    totals,
    hasTransitionHistory: true,
    fullHistory,
    caveat: fullHistory
      ? null
      : "Transition history begins mid-lifecycle; time before the first recorded move is attributed to the earliest known phase.",
  };
}

export interface SpecLifecycleSummary {
  createdAt: string;
  currentPhase: SpecPhase;
  ageDays: number;
  timeInCurrentPhaseDays: number;
  tasks: { total: number; complete: number };
  acs: { total: number; verified: number; failing: number; covered: number };
}

/** The lifecycle summary strip: created/phase/age/time-in-phase, task progress, AC health (dec-5). */
export async function specLifecycleSummary(memexId: string, docId: string): Promise<SpecLifecycleSummary | null> {
  const [doc] = (await db.execute(sql`
    SELECT created_at AS "createdAt", status, status_changed_at AS "statusChangedAt"
    FROM documents WHERE id = ${docId} AND memex_id = ${memexId}
  `)) as unknown as Array<{ createdAt: string; status: string; statusChangedAt: string }>;
  if (!doc) return null;

  const [taskRow] = (await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'complete')::int AS complete
    FROM tasks WHERE doc_id = ${docId}
  `)) as unknown as Array<{ total: number; complete: number }>;

  const verification = await specAcVerification(memexId, docId);

  const now = Date.now();
  return {
    createdAt: new Date(doc.createdAt).toISOString(),
    currentPhase: normalizePhase(doc.status),
    ageDays: toDays(now - new Date(doc.createdAt).getTime()),
    timeInCurrentPhaseDays: toDays(now - new Date(doc.statusChangedAt ?? doc.createdAt).getTime()),
    tasks: { total: taskRow?.total ?? 0, complete: taskRow?.complete ?? 0 },
    acs: {
      total: verification.total,
      verified: verification.verified,
      failing: verification.failing,
      covered: verification.verified + verification.failing,
    },
  };
}

export interface SpecTaskVelocityPoint {
  day: string;
  created: number;
  started: number;
  completed: number;
}

export interface SpecTaskVelocity {
  /** Gapless daily counts of task lifecycle events; empty when the spec has no tasks. */
  points: SpecTaskVelocityPoint[];
  statusBreakdown: { not_started: number; in_progress: number; complete: number };
}

/** Task velocity: per-day created/started/completed + the current status split (dec-5). */
export async function specTaskVelocity(memexId: string, docId: string): Promise<SpecTaskVelocity> {
  const points = (await db.execute(sql`
    WITH ev AS (
      SELECT created_at::date AS day, 'created' AS kind FROM tasks WHERE doc_id = ${docId}
      UNION ALL SELECT started_at::date, 'started' FROM tasks WHERE doc_id = ${docId} AND started_at IS NOT NULL
      UNION ALL SELECT completed_at::date, 'completed' FROM tasks WHERE doc_id = ${docId} AND completed_at IS NOT NULL
    ),
    per_day AS (SELECT day, kind, count(*)::int AS n FROM ev GROUP BY 1, 2),
    days AS (
      SELECT generate_series((SELECT min(day) FROM per_day), CURRENT_DATE, interval '1 day')::date AS day
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS day,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.kind = 'created'), 0)::int AS created,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.kind = 'started'), 0)::int AS started,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.kind = 'completed'), 0)::int AS completed
    FROM days LEFT JOIN per_day ON per_day.day = days.day
    GROUP BY days.day ORDER BY days.day
  `)) as unknown as SpecTaskVelocityPoint[];

  const statusRows = (await db.execute(sql`
    SELECT status, count(*)::int AS n FROM tasks WHERE doc_id = ${docId} GROUP BY status
  `)) as unknown as Array<{ status: string; n: number }>;
  const byStatus = new Map(statusRows.map((r) => [r.status, r.n]));

  return {
    points,
    statusBreakdown: {
      not_started: byStatus.get("not_started") ?? 0,
      in_progress: byStatus.get("in_progress") ?? 0,
      complete: byStatus.get("complete") ?? 0,
    },
  };
}

/** Spec-scoped AC verification donut — the spec's own active ACs, rolled up like acVerification (dec-5). */
export async function specAcVerification(memexId: string, docId: string): Promise<AcVerificationSummary> {
  const [{ total }] = (await db.execute(sql`
    SELECT count(*)::int AS total
    FROM acs WHERE memex_id = ${memexId} AND brief_id = ${docId} AND status = 'active'
  `)) as unknown as Array<{ total: number }>;

  const prefix = await specAcUidPrefix(memexId, docId);
  if (!prefix) return { total, verified: 0, failing: 0, untested: total };

  const [rollup] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE has_fail)::int AS failing,
      count(*) FILTER (WHERE NOT has_fail AND has_pass)::int AS verified
    FROM (
      SELECT
        subject_ref,
        bool_or(latest_status IN ('fail', 'error')) AS has_fail,
        bool_or(latest_status = 'pass') AS has_pass
      FROM test_event_latest
      WHERE subject_ref LIKE ${prefix + "%"}
      GROUP BY subject_ref
    ) per_ac
  `)) as unknown as Array<{ failing: number; verified: number }>;

  const { failing, verified } = rollup ?? { failing: 0, verified: 0 };
  return { total, verified, failing, untested: Math.max(0, total - verified - failing) };
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

/**
 * The who/what/when audit for ONE spec, off `activity_view` sliced by spec_ref
 * (dec-3). Curated by default — drops reads (`viewed`), test-event rows, and the
 * unattributed system sweeps (the activity_view has no actor_kind column, so a
 * `system` actor surfaces as an activity_log-arm row with a server channel and no
 * resolved user). `showAll` re-admits the full slice. Newest-first, paginated.
 * actor_user_id is never projected — the denormalised display name is the WHO.
 */
export async function specActivityAudit(
  memexId: string,
  docId: string,
  opts: { showAll?: boolean; limit?: number; offset?: number } = {},
): Promise<SpecActivityAudit> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const curated = opts.showAll
    ? sql``
    : sql`AND action IS DISTINCT FROM 'viewed'
          AND kind <> 'test_event'
          AND NOT (kind = 'activity_log' AND actor_user_id IS NULL AND channel = 'server')`;

  const rows = (await db.execute(sql`
    SELECT
      at,
      COALESCE(actor_name, actor_raw) AS "actorName",
      channel,
      kind,
      action,
      narrative,
      entity_id AS "entityId"
    FROM activity_view
    WHERE memex_id = ${memexId} AND spec_ref = ${docId}
    ${curated}
    ORDER BY at DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `)) as unknown as SpecActivityRow[];

  const hasMore = rows.length > limit;
  return {
    rows: (hasMore ? rows.slice(0, limit) : rows).map((r) => {
      const at = r.at as unknown as string | Date;
      return { ...r, at: at instanceof Date ? at.toISOString() : new Date(at).toISOString() };
    }),
    hasMore,
  };
}
