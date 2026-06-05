// Spec analytics aggregates (spec-179) — the read side of the Insights page.
//
// Every function is memex-scoped and aggregates in SQL (GROUP BY day/status,
// percentile_cont for medians) so the browser receives chart-shaped series,
// never raw document rows. These are reads — std-8's mutate() contract does
// not apply. Tenancy: callers pass a memexId that memexResolver + session
// middleware already authorized (std-7: outsiders 404 upstream).
//
// Phase vocabulary: spec rows carry the renamed lifecycle (draft / plan /
// build / verify / done — dec-3 of doc-10). Legacy values can't appear on
// docType='spec' rows post-rename, but the CASE normalisation below keeps the
// aggregates correct even if a stray legacy row survives.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

export const SPEC_PHASES = ["draft", "plan", "build", "verify", "done"] as const;
export type SpecPhase = (typeof SPEC_PHASES)[number];

// Normalise a documents.status value onto the spec lifecycle. Mirrors the
// rename mapping (review→plan, implementation→build, approved→done).
const PHASE_CASE = sql.raw(`
  CASE status
    WHEN 'review' THEN 'plan'
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
  plan: number;
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
      (sum(COALESCE(CASE WHEN per_day.phase = 'plan'   THEN per_day.created END, 0)) OVER w)::int AS plan,
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
 * for "reached" — a spec in build has by definition reached draft/plan/build.
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

export const ACTOR_KINDS = ["human", "mcp_agent", "in_app_agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface ActivityByActorPoint {
  day: string;
  human: number;
  mcp_agent: number;
  in_app_agent: number;
  system: number;
}

/**
 * "Who is doing the work?" — per-day activity_log rows split by actor kind,
 * gapless from the first row to today. Two exclusions keep this a measure of
 * WORK rather than noise: `viewed` rows (reads, dominated by page loads) and
 * `test_event` rows (one per test invocation — a single CI run would dwarf a
 * week of authoring).
 */
export async function activityByActor(memexId: string): Promise<ActivityByActorPoint[]> {
  const rows = (await db.execute(sql`
    WITH per_day AS (
      SELECT created_at::date AS day, actor_kind, count(*)::int AS n
      FROM activity_log
      WHERE memex_id = ${memexId}
        AND action <> 'viewed'
        AND entity <> 'test_event'
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
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.actor_kind = 'in_app_agent'), 0)::int AS in_app_agent,
      COALESCE(sum(per_day.n) FILTER (WHERE per_day.actor_kind = 'system'), 0)::int AS system
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
 * test)) up to per-AC verdicts, then to one memex-wide summary. ac_uid is the
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
        ac_uid,
        bool_or(latest_status IN ('fail', 'error')) AS has_fail,
        bool_or(latest_status = 'pass') AS has_pass
      FROM test_event_latest
      WHERE ac_uid LIKE ${prefix + "%"}
      GROUP BY ac_uid
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
 * from test_events (first non-hidden pass per ac_uid, prefix-scoped to this
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
    first_pass AS (
      SELECT ac_uid, min(created_at)::date AS day
      FROM test_events
      WHERE ac_uid LIKE ${prefix + "%"} AND status = 'pass' AND hidden = false
      GROUP BY ac_uid
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
 * split by status, prefix-scoped to this memex's ac_uids. Hidden emissions
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
      WHERE ac_uid LIKE ${prefix + "%"}
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
