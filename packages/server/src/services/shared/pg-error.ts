/**
 * Recover the underlying postgres-js driver error from whatever drizzle throws.
 *
 * drizzle-orm ≥0.44 wraps every failed query in a `DrizzleQueryError` and stashes
 * the original driver error (the object carrying `.code` / `.constraint_name`) on
 * `.cause`. Before that — drizzle 0.39, which this repo ran until the 0.45 bump —
 * the driver error was thrown directly, so our conflict handlers read `.code` off
 * the caught value. Walk the `.cause` chain so 23505 / constraint-name
 * introspection keeps working across both shapes.
 */
export interface PgError {
  code?: string;
  constraint_name?: string;
  message?: string;
}

export function pgError(err: unknown): PgError | undefined {
  let cur: unknown = err;
  // Bounded walk: DrizzleQueryError → driver error is one hop; cap to be safe.
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const e = cur as PgError & { cause?: unknown };
    if (typeof e.code === "string") return e;
    cur = e.cause;
  }
  return undefined;
}

/** True when the (possibly drizzle-wrapped) error is a Postgres unique violation. */
export function isUniqueViolation(err: unknown): boolean {
  return pgError(err)?.code === "23505";
}
