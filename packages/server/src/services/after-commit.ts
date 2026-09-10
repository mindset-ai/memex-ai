// spec-560 dec-1 — the one seam every post-commit step routes through.
//
// THE RULE: once a write has committed, nothing that runs afterwards may report the
// write as failed. A handler that commits and then keeps working (store a ballot, route
// standards, compute a footer signal, look up related issues) hands the caller
// `Unexpected server error` over a row that exists — and the caller cannot tell that
// from a total failure. Retrying duplicates; not retrying drops. Both corruptions are
// invisible until a human reads the board.
//
// This is deliberately a NAMED helper rather than an inline try/catch at each site.
// The rule was already known and written down at five seams as prose comments, and got
// missed at twelve others — a comment cannot be checked. `afterCommit` gives the
// post-commit guard something to scan for, so the next handler author is caught by a
// red check rather than by a prod incident.
//
// What it does NOT do: swallow pre-commit validation. Anything that runs BEFORE the row
// exists (spec-499's ballot validation, ref resolution, authorisation) must keep
// throwing — that failure is honest, and the caller has nothing to clean up.

/** Outcome of post-commit work: the value, or the fact that it failed. Never a throw. */
export type AfterCommitOutcome<T> = { ok: true; value: T } | { ok: false };

/**
 * Run work that happens AFTER a write has committed. Never throws.
 *
 * On failure the original error — the object, so its stack survives — is logged and
 * `{ ok: false }` is returned for the caller to turn into an honest response. Logging
 * is not optional: without it this trades a loud defect for a silent one, and a real
 * database outage becomes invisible in Cloud Logging, which is worse than the defect
 * being fixed (std-14, std-50; spec-257 dec-2 set the precedent that a non-gating
 * wrapper must surface failure rather than hide it).
 *
 * `label` names the step, so an operator reading the log knows which half failed and
 * therefore what the caller was told.
 */
export async function afterCommit<T>(
  label: string,
  work: () => Promise<T>,
): Promise<AfterCommitOutcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    console.error(
      `[after-commit] ${label} failed AFTER the write committed — the write STANDS:`,
      err,
    );
    return { ok: false };
  }
}
