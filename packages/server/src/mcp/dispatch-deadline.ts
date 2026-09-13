// spec-562 — bound how long an MCP call may run before its caller is answered.
//
// THE DEFECT THIS CLOSES. postgres-js has two pool-starvation behaviours. When a
// connection must be OPENED it is bounded by `connect_timeout` and throws — that
// was incident 1 on 2026-09-10, fixed by spec-560. When every connection is FULL
// the query joins an UNBOUNDED queue (`queries.push`, index.js:341) that rejects
// only on pool destroy. That was incident 2: a `create_task` went silent for 305
// seconds and wrote nothing. Nothing threw, so nothing reached prod stderr; the
// only trace was a client giving up.
//
// WHAT THIS DOES NOT DO. A deadline here does NOT cancel the in-flight query.
// Postgres keeps executing and the write may land AFTER the caller has been told
// the call timed out. That is why the outcome is `timedOut`, never `failed` — the
// caller must be told the result is UNKNOWN and sent to read back before retrying.
// Reporting "failed" would be spec-560's own defect moved to a new location
// (spec-562 dec-3, ac-10).

/**
 * How long an MCP tool call may run before its caller is answered.
 *
 * ── The measurement behind this number (spec-562 dec-2, ac-8) ──────────────────
 * Read from `mcp_tool_calls.duration_ms` in production on 2026-09-13, over a
 * window starting 2026-09-12 19:00 UTC — the first clean hour after spec-563
 * deployed. Anything earlier straddles that fix and averages two different
 * systems.
 *
 *   sample   878 calls
 *   < 1s     638   72.7%
 *   1-5s     240   27.3%
 *   > 5s       0      —
 *   worst    4 799 ms (update_task); worst p99 of any tool 4 799 ms
 *
 * 30 000 ms sits in a PROVABLY EMPTY region — six times the observed maximum, in
 * an interval containing no calls at all. So it cuts nothing legitimate, and the
 * 305-second silence becomes a 30-second one.
 *
 * One global value, no per-tool table: with spec-563's activity-footer defect
 * removed the population is homogeneous (every tool under 5 s), so a per-tool
 * table would carry zero exceptions. Before that fix `get_doc` showed a p99 of
 * 23 892 ms against a next-worst of 6 826 ms — but that spread was the defect,
 * not the workload.
 *
 * ── When to reopen this ───────────────────────────────────────────────────────
 * The window is ~18 hours against 30 days for the pre-fix baseline: a legitimate
 * slow call occurring weekly did not occur in it. A measurement of the present
 * can falsify a bound but never confirm one [per std-50 cl-8]. So:
 *
 *   - re-measure after a full week on the healthy baseline (from 2026-09-19);
 *   - re-measure whenever a long-running tool path is added;
 *   - if a LEGITIMATE call above 10 s appears, reopen spec-562 dec-2 rather than
 *     quietly tolerating it.
 *
 * This distribution describes calls that COMPLETED. `logToolCall` runs in a
 * `finally`, so a call that never settles writes no row: the 2026-09-10 hang is
 * absent from the numbers above, not present as an outlier. These figures can
 * show that the deadline breaks nothing; they can never show that it would have
 * caught the incident. Counting breaches is the log line's job (ac-12).
 */
export const MCP_DISPATCH_DEADLINE_MS = 30_000;

export interface DispatchDeadlineOptions {
  /** Tool name, for the breach log line. NOT a key for a per-tool deadline. */
  readonly toolName: string;
  /** Called once, when a timed-out call's work eventually settles (ac-11/ac-12). */
  readonly onLateSettle?: (outcome: LateSettlement) => void;
}

export interface LateSettlement {
  readonly toolName: string;
  /** True elapsed ms of the underlying work — never the deadline value. */
  readonly elapsedMs: number;
  /** The error OBJECT when the late work threw, so its stack survives (std-14). */
  readonly error?: unknown;
}

export type DispatchOutcome<T> =
  | { readonly timedOut: false; readonly value: T }
  | { readonly timedOut: true };

/**
 * Race `work` against the deadline.
 *
 * Resolves `{ timedOut: false, value }` if the work wins. Resolves
 * `{ timedOut: true }` if the deadline wins — the work is NOT cancelled and keeps
 * running; when it finally settles, `onLateSettle` reports its TRUE elapsed time.
 *
 * REJECTS if the work rejects in time: a deadline must not swallow a real error.
 *
 * `Promise.race` attaches a handler to every input, so the losing promise's later
 * rejection is handled and discarded — no unhandled rejection. That property is
 * why the race is used rather than abandoning the promise from a timer callback,
 * and it is pinned by a test (ac-13) so a refactor cannot quietly lose it.
 */
export function withDispatchDeadline<T>(
  work: Promise<T>,
  opts: DispatchDeadlineOptions,
): Promise<DispatchOutcome<T>> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<DispatchOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), MCP_DISPATCH_DEADLINE_MS);
    // Do not hold the event loop open on the deadline alone.
    timer?.unref?.();
  });

  const raced = work.then(
    (value) => ({ timedOut: false as const, value }),
    (err) => {
      throw err;
    },
  );

  return Promise.race([raced, deadline]).then((outcome) => {
    if (!outcome.timedOut) {
      if (timer) clearTimeout(timer);
      return outcome;
    }
    // The caller is answered now; the work runs on. Report what it really cost
    // when it lands, so a breach is never recorded as a fast success (ac-11).
    void work.then(
      () => opts.onLateSettle?.({ toolName: opts.toolName, elapsedMs: Date.now() - started }),
      (error) =>
        opts.onLateSettle?.({
          toolName: opts.toolName,
          elapsedMs: Date.now() - started,
          error,
        }),
    );
    return outcome;
  });
}

/**
 * What the caller is told when the deadline fires (spec-562 dec-3, ac-10).
 *
 * The three readings this must NOT admit, because the query may still commit
 * after the caller has been answered:
 *
 *   "failed" / "nothing was written" — spec-560's defect relocated. An agent that
 *       cannot tell `created` from `not created` either duplicates or silently drops.
 *   "safe to retry" — the inverse of spec-332 dec-4's `429 + Retry-After`, which
 *       means nothing was dispatched. Both live on this seam and must stay visibly
 *       distinct; conflating them retries a call that may already have written.
 *
 * So: state the outcome is unknown, and send the caller to READ BACK first.
 */
export function dispatchTimeoutMessage(toolName: string): string {
  const seconds = Math.round(MCP_DISPATCH_DEADLINE_MS / 1000);
  return [
    `⏱ UNKNOWN OUTCOME — \`${toolName}\` did not finish within ${seconds}s.`,
    "",
    "This is NOT a failure report. The call is still running on the server and may",
    "yet complete, so whether your change landed is genuinely unknown right now.",
    "",
    "Do NOT retry blind — a retry can duplicate a write that already succeeded.",
    "READ BACK first: fetch the thing you were changing and see which state it is in.",
    "Then act on what you find: retry only if the change is genuinely absent.",
  ].join("\n");
}
