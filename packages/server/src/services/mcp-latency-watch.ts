// spec-563 t-6 (dec-2) — the tail watcher.
//
// WHAT IT WATCHES AND WHY IT IS NOT A NEW SENSOR. `src/mcp/tools.ts` already times every
// MCP tool invocation and `logToolCall` writes it to `mcp_tool_calls` — in production, on
// every call, with `duration_ms`, `tool_name`, `memex_id` and `created_at`. dec-2 chose to
// READ that rather than install anything, because every alternative built a sensor and the
// one sensor this system already had (spec-412's OTEL metrics) has been emitting nothing
// in both environments for months while continuing to look like a dependency.
//
// ── THE TWO RULES THIS EXISTS TO OBEY ──────────────────────────────────────────────────
//
// 1. WATCH THE TAIL, NEVER AN AVERAGE. Over the window this replaces, `get_doc`'s median
//    IMPROVED — p50 1 222 ms → 579 ms — while p95 went 2 167 ms → 31 010 ms. An alert on a
//    mean stayed green for eleven days and a dashboard on the median showed a win. So this
//    computes a high percentile and a slow-call count, and never a mean.
//
// 2. NEVER KEY ON ERRORS. Nothing errors: the call completes, it is merely slow. Verified
//    against prod — 2 responses ≥500 on /mcp in 7 days, both sub-second, so not slow calls
//    timing out. An error-rate alert cannot see this defect at all.
//
// ── AGGREGATES ONLY, AND THAT IS A SECURITY CONSTRAINT ─────────────────────────────────
//
// `mcp_tool_calls` also carries `args_json` (tool arguments verbatim), `user_id`, and in
// dev mode `result_text`. NOTHING from a row reaches a caller of this module: the shape
// returned is counts and durations. std-31 sharpens this — this Memex builds itself in the
// open, so an alert quoting a row could carry a real person's name into a public artifact.
//
// ── COST (std-39) ──────────────────────────────────────────────────────────────────────
//
// `mcp_tool_calls` has no retention, so it grows without bound and the scan target grows
// with it. Every index on it is a (column, created_at) COMPOSITE — there is no standalone
// `created_at` index — so a query filtered only by time cannot use one and degrades into a
// full scan that gets slower every week. Filtering by `tool_name` is therefore not a
// convenience: it is what lets this read stand on `mcp_tool_calls_tool_error_idx`
// (tool_name, created_at). A watcher that degrades the database it watches is its own
// incident.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

/** Tools whose tail is worth watching. Each one is a separate index-backed read. */
export const WATCHED_TOOLS = ["get_doc"] as const;

export type TailBreach = {
  toolName: string;
  memexId: string | null;
  calls: number;
  p95Ms: number;
  slowCalls: number;
};

export type TailReading = TailBreach & { breached: boolean };

export type WatchOptions = {
  /** How far back to look. */
  windowMinutes?: number;
  /** A call at or above this is "slow". */
  slowMs?: number;
  /** p95 at or above this trips the alert. */
  p95ThresholdMs?: number;
  /**
   * Below this many calls in the window, a percentile is noise and NOTHING is reported.
   * One slow call out of three is a p95 of "that call" — alerting on it teaches people to
   * mute the alert, which is how the next eleven-day window starts.
   */
  minCalls?: number;
  tools?: readonly string[];
};

const DEFAULTS = {
  windowMinutes: 60,
  slowMs: 10_000,
  p95ThresholdMs: 10_000,
  minCalls: 20,
} as const;

/**
 * Read the tail of the watched tools over a rolling window, per tool AND per tenant.
 *
 * Per-tenant is load-bearing rather than decorative: the defect this watches degraded ONE
 * Memex (4.1M rows) while every other tenant stayed healthy, so a fleet-wide percentile
 * would have been diluted below any threshold worth setting. Grouping is what makes a
 * single noisy tenant visible.
 */
export async function readLatencyTail(opts: WatchOptions = {}): Promise<TailReading[]> {
  const windowMinutes = opts.windowMinutes ?? DEFAULTS.windowMinutes;
  const slowMs = opts.slowMs ?? DEFAULTS.slowMs;
  const p95ThresholdMs = opts.p95ThresholdMs ?? DEFAULTS.p95ThresholdMs;
  const minCalls = opts.minCalls ?? DEFAULTS.minCalls;
  const tools = opts.tools ?? WATCHED_TOOLS;

  if (tools.length === 0) return [];

  // percentile_disc returns an ACTUAL observed value rather than interpolating between
  // two, so a reported p95 is always a duration some call really took — which matters when
  // the number ends up in an incident note.
  // Every value is BOUND, never interpolated — `tools` is a module constant today, but a
  // query that would be injectable if its input ever came from elsewhere is a defect
  // waiting for the day someone makes it configurable. `make_interval` takes the window as
  // a parameter, so no interval literal is built by string concatenation either.
  //
  // ⚠ `= ANY(${array})` does NOT work here: drizzle's sql template flattens a JS array
  // into ONE parameter, which Postgres then rejects as a malformed array literal
  // (22P02). sql.join binds each element as its own parameter, which is both correct and
  // still fully parameterised.
  const rows = (await db.execute(sql`
    SELECT tool_name                                                      AS "toolName",
           memex_id                                                       AS "memexId",
           count(*)::int                                                  AS "calls",
           percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS "p95Ms",
           count(*) FILTER (WHERE duration_ms >= ${slowMs})::int          AS "slowCalls"
      FROM mcp_tool_calls
     WHERE tool_name IN (${sql.join(
       tools.map((t) => sql`${t}`),
       sql`, `,
     )})
       AND created_at >= now() - make_interval(mins => ${windowMinutes})
     GROUP BY tool_name, memex_id
  `)) as unknown as TailBreach[];

  // ⚠ THE OR IS LOAD-BEARING, AND IT WAS MEASURED RATHER THAN ASSUMED.
  //
  // A percentile is BLIND to a tail exactly its own width. Replaying this Spec's own
  // window — 95 calls at 579 ms plus 5 at 31 010 ms — `percentile_disc(0.95)` lands on the
  // last FAST value and reports 579 ms. The p95 arm alone does not see the very incident
  // this watcher exists for, and it is a knife edge: one more slow call and it fires, one
  // fewer and it does not.
  //
  // The slow-call count has no such edge, so it is what actually catches that shape. Both
  // arms are live (the test proves the p95 arm fires on a wider tail) — neither is a prop,
  // and removing either leaves a blind spot that looks exactly like health.
  return rows
    .filter((r) => r.calls >= minCalls)
    .map((r) => ({ ...r, breached: r.p95Ms >= p95ThresholdMs || r.slowCalls > 0 }));
}

/**
 * Emit one line per breach, as WHOLLY-JSON on stdout.
 *
 * ⚠ NO `[domain]` PREFIX, deliberately, and this is the difference between a working
 * monitor and a silent one. Cloud Logging turns a wholly-JSON stdout line into a queryable
 * `jsonPayload`; a prefixed line stays an opaque `textPayload` and a log-based metric
 * built on field predicates matches NOTHING — reporting silence, which reads as health.
 * That is precisely the failure mode dec-2 exists to end, so it must not be reintroduced
 * by the delivery mechanism. It is the one sanctioned exception to std-14's per-domain
 * prefix convention, and the reason is recorded here rather than left to be rediscovered.
 *
 * Only aggregates are emitted. No args, no user, no row content.
 */
export function reportBreaches(readings: TailReading[]): TailReading[] {
  const breaches = readings.filter((r) => r.breached);
  for (const b of breaches) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: "mcp_latency_tail_breach",
        tool: b.toolName,
        memexId: b.memexId,
        calls: b.calls,
        p95Ms: b.p95Ms,
        slowCalls: b.slowCalls,
      }),
    );
  }
  return breaches;
}

/** One tick: read, then report. Returns what breached, for the caller's response body. */
export async function runLatencyTailWatch(opts: WatchOptions = {}): Promise<{
  readings: number;
  breaches: TailReading[];
}> {
  const readings = await readLatencyTail(opts);
  return { readings: readings.length, breaches: reportBreaches(readings) };
}
