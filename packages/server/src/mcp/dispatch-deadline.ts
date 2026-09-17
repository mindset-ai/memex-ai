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
 * IN FORCE: 60000 ms — set by dec-4 on 2026-09-17. This line is machine-checked
 * against the constant below (ac-8): the prose elsewhere cites earlier values as
 * history, so only this line states what is actually in force.
 *
 * ── The measurement behind this number (spec-562 dec-4, ac-8) ──────────────────
 * Read from `mcp_tool_calls.duration_ms` in production on 2026-09-17, over the
 * window since the deadline itself went live (2026-09-13 16:05 UTC). Earlier data
 * straddles that deploy and averages two different systems.
 *
 *   sample                     8 344 calls over 90.5 hours
 *   slowest LEGITIMATE call    22 469 ms  (create_decision)
 *                              11 792 ms  (create_decision)
 *                              10 083 ms  (update_task)
 *   breaches                   1 — and it was a FALSE POSITIVE (see below)
 *
 * 60 000 ms is 2.7x the slowest legitimate call. It cuts nothing observed in 90
 * hours.
 *
 * ── Why this was 30 000 ms until 2026-09-17, and why it moved ─────────────────
 * dec-2 set 30 000 on 878 calls over 18 hours where nothing exceeded 5 s, and
 * wrote its own reopen trigger: a legitimate call above 10 s reopens it. Three
 * appeared. The original window was not wrong, it was small — calls occurring a
 * few times a week cannot show up in 18 hours.
 *
 * The cost was real before it was theoretical. On 2026-09-15 a legitimate
 * `create_task` was cut at 30 s and settled at 35 s, so its caller was told
 * UNKNOWN about a write that had committed 34.5 s earlier.
 *
 * ── What raising this COSTS, which is not nothing ─────────────────────────────
 * This deadline exists to bound silence: the 2026-09-10 incident was 305 seconds
 * of nothing. At 30 s that bound was tight; at 60 s a caller waits a full minute
 * before learning anything. 60 s still beats 305 s decisively, but the trade is
 * deliberate — FEWER FALSE POSITIVES, BOUGHT WITH A LONGER WORST-CASE SILENCE.
 * Anyone changing this number should see both halves.
 *
 * One global value, no per-tool table: the population is homogeneous. Before
 * spec-563 `get_doc` showed a p99 of 23 892 ms against a next-worst of 6 826 ms,
 * but that spread was a defect (its activity footer ran on every response, writes
 * included), not the workload.
 *
 * ── When to reopen this ───────────────────────────────────────────────────────
 * A measurement of the present can falsify a bound but never confirm one
 * [per std-50 cl-8]. 90 hours has almost certainly not seen the whole tail.
 *
 *   - a LEGITIMATE call above 20 000 ms reopens dec-4 rather than being tolerated;
 *   - spec-567 landing should trigger a DOWNWARD re-measurement — it found that
 *     standards routing costs ~2 s of post-commit work on every mutation, which
 *     is why these calls are slow. Removing that tax makes 60 000 loose; do not
 *     assume it makes 60 000 correct.
 *   - re-measure whenever a long-running tool path is added.
 *
 * This distribution describes calls that COMPLETED. `logToolCall` runs in a
 * `finally`, so a call that never settles writes no row: the 2026-09-10 hang is
 * absent from the numbers above. These figures show the deadline breaks nothing;
 * they can never show it would have caught the incident. Counting breaches is the
 * log line's job (ac-12) — one in 8 344 calls so far.
 */
export const MCP_DISPATCH_DEADLINE_MS = 60_000;

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
