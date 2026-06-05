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
