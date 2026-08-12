// spec-525 t-1 — the admission gate primitive for AC-emission ingest.
//
// WHAT THIS IS FOR. On 2026-08-11 a revision cutover under peak emission load exhausted
// Cloud SQL: `FATAL 53300 remaining connection slots are reserved`, 400+ user-visible
// 500s in one minute on real traffic. The application was up and answering; it could not
// obtain a connection. Emission volume is an input we do not control — every stack
// without an official helper hand-rolls the protocol (std-22), and 24 consumer packages
// pin a version that predates batching — so the ingest path has to survive whatever
// arrives (spec-525 dec-4 in spec-332's programme).
//
// THE ONE DESIGN CONSTRAINT EVERYTHING ELSE FOLLOWS FROM: **the gate decides without
// touching the database.** A rate limiter keyed on a Postgres row (`services/auth-rate-
// limit.ts`) costs one statement per call — a connection per request, which is the
// resource under pressure. An in-process in-flight cap costs a map lookup. That is why
// this module imports nothing but `node:crypto` and a zero-import pool declaration, and
// why it is a plain object rather than anything that could grow a query (ac-7).
//
// TWO BOUNDS, DOING TWO DIFFERENT JOBS (dec-2):
//
//   instance ceiling — protects the POOL. Derived from the resolved pool size, so
//     emission can never hold more than a stated fraction of an instance's connections
//     however many distinct credentials turn up. User traffic always retains some.
//   per-key slice   — protects TENANTS FROM EACH OTHER. Without it, a single ceiling is
//     the worst option rather than the simple one: one emitter is ~90% of ingest load,
//     so it wins the race for slots essentially always and the emissions shed are
//     everyone else's — shed invisibly, since the emitter swallows the 429 by contract.
//
// WHAT THIS MODULE DELIBERATELY IS NOT:
//   - It does not wait. `tryAcquire` answers immediately. The bounded wait that makes
//     the loss rate acceptable is t-2; this is the bound it waits against.
//   - It does not know about shadow mode. Counting-without-refusing is t-3, layered on.
//   - It does not know about HTTP. Mounting it ahead of authentication is t-4.
//   - It does not emit metrics. The labelled shed counter is t-5; `ShedCause` below is
//     the vocabulary it will label with.

import { createHash } from "node:crypto";
import { resolvePoolMax } from "../../db/pool-size.js";

/**
 * Why an emission was refused. These mean opposite things and demand opposite responses
 * — one credential over-emitting, versus the instance genuinely saturated — so t-5's
 * counter labels by this rather than reporting an undifferentiated total (ac-14).
 */
export type ShedCause = "key_slice_full" | "instance_ceiling_full";

export type Acquisition =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly cause: ShedCause };

/**
 * The fraction of an instance's pool that emission may hold at once.
 *
 * A half leaves the other half for user traffic unconditionally. That is a structural
 * guarantee rather than a tuned number: it holds at any pool size, and it holds when
 * someone changes the pool without thinking about this file.
 */
const CEILING_SHARE_OF_POOL = 0.5;

/**
 * Hard cap on distinct keys tracked at once.
 *
 * A BACKSTOP, not the primary defence. Entries are deleted the moment a key's last slot
 * is released, so the live size is bounded by `ceiling` — far below this. The cap exists
 * so that a future change which retains per-key state past release (a wait queue, a rate
 * window) cannot silently reintroduce unbounded growth on a route reached BEFORE
 * authentication, where the set of distinct credentials is caller-controlled. That is the
 * defect spec-332 dec-12 had to retrofit onto `rate_limit_counters`; here it is designed
 * out rather than patched later.
 */
const MAX_TRACKED_KEYS = 4096;

/** Bucket for requests arriving with no credential at all. */
const ANONYMOUS_KEY = "anonymous";

/**
 * Emission's share of the pool, as a whole number of connections.
 *
 * Floors rather than rounds — half of 5 is two slots, not three; taking the extra one
 * would eat into the half this exists to reserve. Never returns zero: a pool of one must
 * still admit one emission at a time, or the route is closed rather than protected.
 */
export function deriveCeiling(poolMax: number): number {
  return Math.max(1, Math.floor(poolMax * CEILING_SHARE_OF_POOL));
}

/**
 * How much of the ceiling ONE credential may hold.
 *
 * Strictly below the ceiling, which is exactly what ac-10 requires: a key that has
 * saturated its own slice must still leave room for a second credential in the same
 * window. `ceiling - 1` is the most generous value satisfying that, so this rations as
 * little as fairness allows.
 *
 * A consequence worth knowing at prod's numbers: pool 4 → ceiling 2 → slice 1, so a
 * single dominant emitter gets one write in flight per instance rather than two. With
 * t-2's bounded wait that costs latency, not events. Whether it costs anything that
 * matters is a question for t-10's shadow measurement, not for a guess here.
 */
export function derivePerKeySlice(ceiling: number): number {
  return Math.max(1, ceiling - 1);
}

/**
 * Hash the credential AS PRESENTED.
 *
 * Deliberately NOT a lookup. Knowing which workspace a key maps to is unnecessary for
 * giving that key its own share, and resolving it would put an auth query on the path
 * whose entire purpose is to decide without one. String handling alone (ac-9).
 *
 * Hashed rather than stored raw because the gate runs BEFORE authentication: it handles
 * unverified secrets from unauthenticated callers, so the structure must never hold a
 * credential in the clear, and nothing that dumps its state may reveal one.
 */
function keyOf(presentedToken: string): string {
  const trimmed = presentedToken.trim();
  if (trimmed.length === 0) return ANONYMOUS_KEY;
  return createHash("sha256").update(trimmed).digest("base64url").slice(0, 22);
}

export interface EmissionGateOptions {
  /** Pool size to derive from. Defaults to the resolved `DB_POOL_MAX`. */
  readonly poolMax?: number;
  /** Backstop cap on tracked keys. Defaults to {@link MAX_TRACKED_KEYS}. */
  readonly maxTrackedKeys?: number;
}

/**
 * In-process admission control for one instance's emission ingest.
 *
 * Single-threaded by construction: Node runs one request's synchronous section at a
 * time, so a counter needs no lock. Per instance, not per cluster — which is correct
 * here, because the resource being protected (the connection pool) is per instance too.
 */
export class EmissionGate {
  /** Emission's share of this instance's pool. */
  readonly ceiling: number;
  /** The most one credential may hold. Strictly below {@link ceiling}. */
  readonly perKeySlice: number;
  /** Backstop cap on tracked keys; see {@link MAX_TRACKED_KEYS}. */
  readonly maxTrackedKeys: number;

  /** hashed key → slots currently held. An entry exists only while its count is > 0. */
  readonly #held = new Map<string, number>();
  #inFlight = 0;

  constructor(options: EmissionGateOptions = {}) {
    const poolMax = options.poolMax ?? resolvePoolMax();
    this.ceiling = deriveCeiling(poolMax);
    this.perKeySlice = derivePerKeySlice(this.ceiling);
    this.maxTrackedKeys = options.maxTrackedKeys ?? MAX_TRACKED_KEYS;
  }

  /** Slots currently held across all credentials. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Distinct credentials currently holding at least one slot. */
  get trackedKeys(): number {
    return this.#held.size;
  }

  /**
   * Take a slot, or say why not. Answers immediately — never waits (that is t-2).
   *
   * Order matters: the per-key slice is checked FIRST so a loud credential is told it
   * filled its own share rather than that the instance is saturated. The labels drive
   * opposite operator responses, so attributing a self-inflicted refusal to instance
   * saturation would send someone to resize the wrong thing.
   */
  tryAcquire(presentedToken: string): Acquisition {
    const key = keyOf(presentedToken);
    const heldByKey = this.#held.get(key) ?? 0;

    if (heldByKey >= this.perKeySlice) {
      return { ok: false, cause: "key_slice_full" };
    }
    if (this.#inFlight >= this.ceiling) {
      return { ok: false, cause: "instance_ceiling_full" };
    }
    // Unreachable while entries are deleted at zero (size ≤ ceiling ≪ cap); the backstop
    // is here so a future change that retains state cannot grow without limit unnoticed.
    if (heldByKey === 0 && this.#held.size >= this.maxTrackedKeys) {
      return { ok: false, cause: "instance_ceiling_full" };
    }

    this.#held.set(key, heldByKey + 1);
    this.#inFlight += 1;

    // Idempotent: a middleware with an error path can plausibly release twice, and a
    // gate that decremented twice would drift OPEN under exactly the load it guards.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
      const remaining = (this.#held.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        // Drop the entry rather than leaving a zero. This is what makes the structure's
        // size bounded by what is in flight instead of by how many credentials have ever
        // been seen — the property that survives a rotating-token flood (ac-11).
        this.#held.delete(key);
      } else {
        this.#held.set(key, remaining);
      }
    };

    return { ok: true, release };
  }

  /**
   * Inspectable state for tests and diagnostics. Exposes hashed keys only — never a
   * presented credential, in whole or in part.
   */
  debugState(): { ceiling: number; perKeySlice: number; inFlight: number; keys: Array<{ key: string; held: number }> } {
    return {
      ceiling: this.ceiling,
      perKeySlice: this.perKeySlice,
      inFlight: this.#inFlight,
      keys: [...this.#held].map(([key, held]) => ({ key, held })),
    };
  }
}
