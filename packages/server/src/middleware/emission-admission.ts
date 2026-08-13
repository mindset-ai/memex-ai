// spec-525 t-4 — the admission gate, on the request path.
//
// WHERE THIS RUNS, AND WHY THE PLACEMENT IS THE WHOLE TASK. Registered in `app.ts`
// immediately BEFORE `memexResolver`, scoped to `/api/test-events/*`. Everything
// ahead of it is verified DB-free — `secureHeaders()`, `cors()`, `hostGuard`, and the
// b-105 legacy-path redirect (pure regex, no lookup) — so a decision here is reached
// with zero SQL, structurally rather than by convention.
//
// It MUST precede `authenticateEmission`: `verifyEmissionKey` is a database read and
// is the route's very first act on both `POST /` and `POST /batch`. A gate placed
// after it spends the exact resource it exists to protect (ac-7).
//
// WHY BEFORE `memexResolver` AND NOT MERELY BEFORE THE ROUTER. Both satisfy t-4's
// wording. After `memexResolver`, the zero-SQL property holds only because
// `parseMemexPath` returns null for this path via `RESERVED_API_ROOTS`
// (`memex-resolver.ts:131`, reached from `:204`) — `/api/test-events` is NOT in
// `NON_TENANT_API_PREFIXES`, contrary to what spec-525 t-4's prose says (see the
// mismatch recorded on that task). That reserved-word dependency is non-obvious and
// has broken silently twice, taking out unsubscribe and spec-489's own `/batch`
// route. Ahead of `memexResolver` there is nothing to depend on.
//
// WHAT IT DOES NOT DO. It does not authenticate and does not resolve a memex. The gate
// keys on the bearer token AS PRESENTED, by string handling alone — an unverified,
// caller-controlled value. That is deliberate (ac-9): resolving the key would cost the
// query the gate exists to avoid. The per-key slice is a fairness mechanism between
// credentials, never an authorization one.
//
// It DOES read the body, but only on `/batch`, and only to size the shed counter in
// emissions rather than requests (ac-13). That costs no database work — the property
// ac-7 protects — and no second parse, because Hono caches parsed bodies and the route
// handler gets this one. See `emissionWeight`.

import type { Context, MiddlewareHandler, Next } from "hono";
import {
  EmissionGate,
  resolveWaitConfig,
  type Acquisition,
} from "../services/admission/emission-gate.js";
import { resolvePoolMax } from "../db/pool-size.js";
import { recordEmissionShed } from "../observability/otel/index.js";
import { MAX_BATCH_EVENTS } from "../routes/test-events.js";

/**
 * The process-wide gate. Lazily built so the pool size and mode are read from the
 * environment in force at first request rather than at module load — the same reason
 * `recordRlsContextViolation` builds its meter lazily.
 */
let gate: EmissionGate | null = null;

/** The gate this process is using, building it on first use. */
export function emissionGate(): EmissionGate {
  if (!gate) {
    const wait = resolveWaitConfig();
    gate = new EmissionGate({
      poolMax: resolvePoolMax(),
      waitMs: wait.waitMs,
      serviceMs: wait.serviceMs,
      // spec-525 t-5: the gate imports nothing that could emit a metric — that is the
      // property t-1 spent its design on — so the instrument is injected here instead.
      // The same hook fires for a real shed and for a shadow-mode would-be shed, which
      // is what puts ac-17's counterfactual on ac-13's counter rather than leaving it
      // in an in-module field.
      onShed: (weight, cause, waited) =>
        recordEmissionShed(weight, { cause, waited }),
    });
  }
  return gate;
}

/**
 * Swap the gate, or reset it to the environment-derived default with `null`.
 *
 * Test seam only. It exists because the property under test is PLACEMENT — whether a
 * shed happens before authentication — and the only way to observe that on the real
 * app is to present it with a gate that is already closed. Saturating the real gate
 * would need concurrency the suite cannot hold deterministically.
 */
export function __setEmissionGateForTest(next: EmissionGate | null): void {
  gate = next;
}

/**
 * Extract the presented bearer token, exactly as the route does (`test-events.ts`),
 * and with no interpretation of it. An absent or malformed credential is NOT exempt —
 * it gets the empty-string key and is bounded like any other (ac-9). Exempting it
 * would hand every unauthenticated caller an unbounded lane.
 */
function presentedToken(c: Context): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * How many EMISSIONS this request carries — the shed counter's unit (ac-13).
 *
 * 1 for the single-event route. For `/batch`, the batch's actual length: `emitBatch`
 * drops the WHOLE bucket on a 429 with no fallback, so one shed batch destroys up to
 * MAX_BATCH_EVENTS = 500 verification results while a per-request count reads 1 — and
 * that gap widens as Half B moves more clients onto batching.
 *
 * **Reading the body here is free, not a compromise.** Hono caches parsed bodies
 * (`bodyCache`, hono/dist/request.js), so the route handler's own `c.req.json()` gets
 * this same parse rather than a second one. It costs no database work, which is the
 * property ac-7 protects — and it is skipped entirely for the single-event route.
 *
 * Falls back to 1 on anything malformed: a body we cannot read is a request we cannot
 * size, and guessing high would inflate the very measurement ac-2's budget comes from.
 */
async function emissionWeight(c: Context): Promise<number> {
  if (!c.req.path.endsWith("/batch")) return 1;
  try {
    const body = (await c.req.json()) as { events?: unknown };
    if (!Array.isArray(body?.events)) return 1;
    return Math.min(Math.max(body.events.length, 1), MAX_BATCH_EVENTS);
  } catch {
    return 1;
  }
}

/**
 * Admission control for `/api/test-events/*`.
 *
 * In **shadow** mode (the default, and what the first deploy runs) the gate evaluates
 * both bounds and the wait exactly as it would when enforcing, counts what it WOULD
 * have refused, and admits everything — so this middleware returns 429 only when the
 * mode is `enforcing`.
 */
export const emissionAdmission: MiddlewareHandler = async (
  c: Context,
  next: Next,
) => {
  const g = emissionGate();
  const acquisition: Acquisition = await g.acquire(
    presentedToken(c),
    await emissionWeight(c),
  );

  if (!acquisition.ok) {
    // Shadow mode never lands here: its acquire admits unconditionally and records the
    // would-be shed instead. So a 429 from this line means the operator turned
    // enforcing on, which is the point of the mode being configuration (t-6).
    return c.json(
      {
        error: "too_many_requests",
        message:
          "Emission ingest is shedding load to protect the database. This is not a " +
          "failure of your test run — the emitter drops a 429 by contract and never " +
          "retries. The acceptance criteria keep their previous status until the next run.",
      },
      429,
    );
  }

  try {
    await next();
  } finally {
    // Released in `finally` so an error path cannot leak a slot — a gate that drifts
    // closed under load would be worse than no gate. `release` is idempotent, so a
    // double call (a plausible shape for error middleware) cannot manufacture capacity.
    acquisition.release();
  }
};

