// spec-525 t-1 — how big is this instance's connection pool?
//
// This module has **zero imports on purpose**, for the same reason `routes/api-roots.ts`
// does. Two places need the answer and neither should drag the other in:
//
//   db/connection.ts                    — sizes the postgres-js pool itself
//   services/admission/emission-gate.ts — derives its ceiling from the pool it protects
//
// The gate importing `db/connection.ts` would pull a live postgres client into a module
// whose whole point is deciding WITHOUT touching the database (spec-525 ac-7), and would
// make its unit tests need one. A dependency-free declaration lets both read the same
// number.
//
// WHY THIS EXISTS AT ALL. Before spec-525 the value was resolved in two places with two
// different parsers: `connection.ts` used a bare `Number(process.env.DB_POOL_MAX ?? 5)`,
// and `observability/otel/config.ts` used a validating parse with the same default. They
// agree on every sane input and disagree on junk — `DB_POOL_MAX=abc` gives the pool
// `NaN` and telemetry `5`. `NaN` as a pool size is bad; `NaN` as an admission ceiling is
// worse, because every `inFlight < ceiling` comparison is false, so the gate would refuse
// everything, or (with the comparison the other way) admit everything. A single validated
// resolution removes the class.

/**
 * The pool size when `DB_POOL_MAX` is unset.
 *
 * Prod overrides this to **4** via the `memex-<env>-deploy-env` secret, so this default
 * is what dev, tests and self-hosted installs run. Anything deriving from the pool must
 * therefore read the resolved value rather than assuming prod's — the whole point of
 * spec-525 ac-12.
 */
export const DEFAULT_POOL_MAX = 5;

type Env = Record<string, string | undefined>;

/**
 * Resolve the per-instance connection-pool size from the environment.
 *
 * Pure: pass an env object, get a number. Invalid input (non-numeric, zero, negative,
 * infinite) falls back to the default rather than propagating — a pool size is a hard
 * resource bound, and there is no sensible "unbounded" reading of a malformed one.
 */
export function resolvePoolMax(env: Env = process.env): number {
  const raw = env.DB_POOL_MAX;
  if (raw === undefined) return DEFAULT_POOL_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_POOL_MAX;
  return Math.floor(n);
}
