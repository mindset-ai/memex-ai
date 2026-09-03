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
/**
 * The marker header naming the gate's effective mode (spec-525 dec-5, ac-20).
 *
 * IT LIVES HERE, not in the middleware, for a reason that cost an int deploy on
 * 2026-08-14. The post-deploy smoke needs only the header NAME, but importing the
 * middleware to get it pulls `routes/test-events.js` -> `db/connection`, which demands
 * DATABASE_URL **at module load** — and the smoke suite hits a remote host with no
 * database. The file died on import, before any assertion or skip guard could run.
 *
 * That is the same trap spec-515 hit TWICE, documented in memex-resolver.ts's re-export
 * note, and the same fix: the constant belongs in a module the smoke can import safely.
 * This one is provably safe — it imports nothing but `node:crypto` and a zero-import
 * pool declaration, with a test that fails if that grows, including one hop out.
 */
export const EMISSION_GATE_HEADER = "x-memex-emission-gate";

/**
 * Why a shed happened — the vocabulary, as DATA rather than as a bare type union.
 *
 * A union cannot be iterated at runtime, so every consumer enumerated its members by
 * hand: two zero maps here, a zero map and a hand-written per-cause delta in
 * `emission-shed-log.ts`, and sum assertions in five test files. dec-6 adds a cause, and
 * against that shape each site fails differently and none of them fails loudly — the
 * heartbeat would simply stop mentioning the new cause, and the tests would keep passing
 * while summing a subset. So the array is the source of truth and the type derives from
 * it: adding a member moves every count with it (ac-26).
 *
 * Order is display order, and the enforcing path's own precedence: the per-key slice is
 * tested first (see {@link EmissionGate.tryAcquire}), so a loud credential is told it
 * filled its own share rather than that the instance is saturated.
 */
export const SHED_CAUSES = [
  "key_slice_full",
  "instance_ceiling_full",
  "event_budget_full",
] as const;

export type ShedCause = (typeof SHED_CAUSES)[number];

/**
 * A per-cause counter map with every member at zero.
 *
 * The only sanctioned way to build one. A literal is what goes stale when the vocabulary
 * grows, and it goes stale silently: a missing key reads `undefined`, and `undefined + 1`
 * is NaN, which then propagates through every comparison downstream without throwing.
 */
export function zeroByCause(): Record<ShedCause, number> {
  return Object.fromEntries(SHED_CAUSES.map((cause) => [cause, 0])) as Record<
    ShedCause,
    number
  >;
}

export type Acquisition =
  | { readonly ok: true; readonly release: () => void; readonly waited: boolean }
  | { readonly ok: false; readonly cause: ShedCause; readonly waited: boolean };

/**
 * `waited` is not decoration. It separates the two regimes this gate switches between:
 * a refusal AFTER waiting means the instance was busy for the whole interval (accidental
 * overload), while a refusal WITHOUT waiting means the waiter set was already full
 * (flood). Those want opposite operator responses, so t-5's counter carries it as a
 * dimension alongside {@link ShedCause}.
 */

/**
 * What the gate DOES with its decision.
 *
 * `shadow` — the whole mechanism runs (bounds, queue, timeouts) against its own counters,
 *   every would-be refusal is counted with its cause, and the caller is admitted anyway.
 *   This is the mode the first deploy runs: it cannot refuse anything, so it cannot make
 *   anything worse, and it is what produces the number ac-2 requires.
 * `enforcing` — the decision is the answer.
 *
 * Switching is configuration, never a code change (ac-17): the rollout's second deploy is
 * meant to be a config-only revision.
 */
export type GateMode = "shadow" | "enforcing";

/**
 * SHADOW, deliberately.
 *
 * t-6 must wire `MEMEX_EMISSION_GATE_MODE` into both `deploy.sh` and the canonical
 * `memex-<env>-deploy-env` secret. Miss either edit and prod silently takes this default —
 * so the default has to be the direction that under-protects rather than the one that
 * enforces limits nobody has measured yet. An unrecognised value falls here too.
 */
export const DEFAULT_GATE_MODE: GateMode = "shadow";

/** Read the mode from the environment. Anything but an exact `enforcing` means shadow. */
export function resolveGateMode(env: Record<string, string | undefined> = process.env): GateMode {
  return env.MEMEX_EMISSION_GATE_MODE === "enforcing" ? "enforcing" : DEFAULT_GATE_MODE;
}

/**
 * What shadow mode observed: what enforcing WOULD have refused, on both axes, and why.
 *
 * **Every field names its unit, and that is not cosmetic.** This interface previously
 * carried `total` under a comment promising "how many emissions" while the code counted
 * REQUESTS — so t-11's heartbeat published a request count that every reader would take
 * for emissions. Measured on the live window (prod `memex-api-00132-64q`, 2.7 h): 3 000
 * refused requests carrying 24 323 emissions, ~8.1 per request, batches up to 261. An
 * ~8x under-report, unbounded above, growing with batch size — which is what spec-489's
 * batching work exists to increase.
 *
 * ac-13 states the rule: "The counter's unit is EMISSIONS LOST, not requests refused …
 * one 429 can destroy 500 emissions while a per-request counter reads 1." ac-14 requires
 * BOTH ("refusals must ALSO be countable as requests"), because one shed batch of 500 and
 * 500 shed single POSTs are identical on the event axis and completely different
 * situations. Neither axis can be inferred from the other; keep both.
 */
export interface WouldShedCount {
  /** EMISSIONS that would have been lost — the batch's weight. ac-13's unit. */
  readonly events: number;
  /** REQUESTS that would have been refused — one per shed, whatever it weighed. */
  readonly requests: number;
  readonly eventsByCause: Record<ShedCause, number>;
  readonly requestsByCause: Record<ShedCause, number>;
  /**
   * t-13 — what the INSTANCE CEILING ALONE would have refused, with the per-key slice
   * removed. The question dec-6 cannot be resolved without.
   *
   * `#take` tests the slice BEFORE the ceiling, so a key already holding its slice can
   * never reach the ceiling check: at prod's numbers (slice 1, ceiling 2) that branch is
   * unreachable for the credential carrying ~90% of load. The window's 100%/0% split is
   * therefore structural, and says nothing about what the ceiling would do on its own.
   *
   * **It is an UPPER BOUND — say so when quoting it.** A refusal is counted when
   * ceiling-only occupancy is full AT ARRIVAL. A real ceiling-only gate would also wait
   * up to `waitMs` and serve some of those from slots freed meanwhile — and 96% of
   * observed refusals had `waited: true`, so that population is large. Modelling the wait
   * would mean a second queue with its own timers on the hot path; the bias is accepted
   * instead because it points the safe way. Small here means option C is safe by a
   * margin; large is a reason to look harder, not a verdict.
   */
  readonly ceilingOnlyEvents: number;
  readonly ceilingOnlyRequests: number;
}

/** Default interval a caller may be held while waiting for a slot. */
export const DEFAULT_WAIT_MS = 250;

/** Assumed time one emission write occupies a slot — the 26–49 ms logged on 2026-08-11. */
export const DEFAULT_SERVICE_MS = 30;

/**
 * Hard ceiling on the configured wait, whatever the environment asks for.
 *
 * The emitter aborts any single request at 5 s and stops starting fallback requests at
 * 4 s (`PER_REQUEST_TIMEOUT_MS` / `FALLBACK_START_DEADLINE_MS`, exported from
 * `@memex-ai-ac/vitest`). A wait approaching either turns "the server held my request
 * briefly" into "the emitter gave up and warned" — the event is lost anyway AND the
 * pressure is not relieved. Misconfiguration is clamped rather than obeyed: the caller's
 * contract outranks our setting. The test pins this against the emitter's exported
 * symbols rather than against copies of 5000/4000 (ac-18).
 */
const MAX_WAIT_MS = 1_000;

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
 * The events budget — dec-6's second term, and the one that bounds what actually costs.
 *
 * The request ceiling above rations slots in the connection pool. It cannot see the
 * resource a QUEUED request consumes, which c-18 measured: a queued request retains its
 * parsed body at 1.1–1.5x its wire bytes (not the 3–5x c-17 asserted), so 80 concurrent
 * worst-case batches — 500 events x 4 KB of metadata — would retain ~181 MB against
 * prod's ~149 MB of headroom, while the observed shape (~8 events per batch) retains
 * ~2.9 MB. **Exactly one shape is dangerous, and it is the simultaneous maximum of every
 * dimension.** A request count reads two 500-event batches as less load than three
 * single-event POSTs; this term does not.
 *
 * DEFAULT DELIBERATELY INERT, the same discipline {@link DEFAULT_GATE_MODE} follows.
 * dec-6 leaves the values to t-10's shadow A/B — two readings of one instrument share the
 * unknown denominator, so it cancels — which means the compiled-in default must not be
 * able to refuse anything before anyone has measured. At prod's ceiling of 2 the most
 * events that can ever be in flight is `2 x MAX_BATCH_EVENTS = 1 000`, so this is
 * provably unreachable today; it becomes load-bearing only when the ceiling rises.
 * c-18's own figure for a ~100 MB heap allowance is of the order of 20 000 concurrent
 * events, which is where this sits.
 */
export const DEFAULT_EVENT_BUDGET = 20_000;

/**
 * Read the events budget from the environment.
 *
 * Configurable without a code change, like every other knob (ac-18) — t-10 turns it from
 * the canonical `memex-<env>-deploy-env` secret. Junk falls back rather than yielding
 * `NaN`: a bound whose every comparison is false is not a bound, which is the trap
 * `Number(process.env.DB_POOL_MAX ?? 5)` set for the pool before t-1.
 */
export function resolveEventBudget(env: Env = process.env): number {
  return positiveIntOr(env.MEMEX_EMISSION_EVENT_BUDGET, DEFAULT_EVENT_BUDGET);
}

/**
 * How many callers may be queued for a slot at once.
 *
 * DERIVED, not picked: it is what the gate can actually drain inside the interval
 * (`ceiling` slots turning over every `serviceMs`). Queueing deeper than that guarantees
 * the tail times out — requests occupying Cloud Run concurrency slots for a refusal they
 * were always going to get, which is precisely the amplification ac-19 exists to stop.
 *
 * Never zero: a gate that queues nobody is the loss system dec-4 rejected.
 */
export function deriveMaxWaiters(
  ceiling: number,
  waitMs: number,
  serviceMs: number,
): number {
  return Math.max(1, Math.floor((ceiling * waitMs) / serviceMs));
}

export interface WaitConfig {
  readonly waitMs: number;
  /** Undefined means "derive it" — the normal case. */
  readonly maxWaiters?: number;
  readonly serviceMs: number;
}

type Env = Record<string, string | undefined>;

function positiveIntOr<T>(raw: string | undefined, fallback: T): number | T {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Read the wait knobs from the environment.
 *
 * All three are configurable WITHOUT a code change, because ac-2 requires them set from
 * shadow-mode data: the second deploy of the rollout is meant to be configuration only.
 * A value compiled in as a literal would make it a code change instead.
 */
export function resolveWaitConfig(env: Env = process.env): WaitConfig {
  return {
    waitMs: positiveIntOr(env.MEMEX_EMISSION_WAIT_MS, DEFAULT_WAIT_MS),
    maxWaiters: positiveIntOr(env.MEMEX_EMISSION_MAX_WAITERS, undefined),
    serviceMs: positiveIntOr(env.MEMEX_EMISSION_SERVICE_MS, DEFAULT_SERVICE_MS),
  };
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
  /** How long a caller may be held. Clamped to {@link MAX_WAIT_MS}. */
  readonly waitMs?: number;
  /** How many callers may queue at once. Defaults to {@link deriveMaxWaiters}. */
  readonly maxWaiters?: number;
  /** Assumed slot occupancy per write, used to derive the waiter bound. */
  readonly serviceMs?: number;
  /** Events in flight allowed at once (dec-6's second term). Defaults to the resolved env. */
  readonly eventBudget?: number;
  /** Shadow (count only) or enforcing. Defaults to the resolved environment. */
  readonly mode?: GateMode;
  /**
   * Called on every shed — real (enforcing) AND simulated (shadow). t-5's counter is
   * wired here rather than imported, so this module keeps the zero-dependency property
   * everything else in it follows from: it still imports nothing but `node:crypto` and
   * a zero-import pool declaration, and there is a test that fails if that grows.
   *
   * `weight` is the number of EMISSIONS the shed destroyed, not requests refused — the
   * caller supplies it because only the caller can see the batch (ac-13).
   *
   * Wiring shadow through the SAME hook is what lets ac-17's would-be shed count reach
   * ac-13's counter; before this it lived only in {@link wouldShed}.
   */
  readonly onShed?: (weight: number, cause: ShedCause, waited: boolean) => void;
}

interface Waiter {
  readonly key: string;
  /**
   * EMISSIONS this caller is carrying. Held on the waiter because the events budget is
   * re-tested when the pump reaches it: a batch that did not fit on arrival may still not
   * fit when a slot frees, and the pump cannot know that from the request count alone.
   */
  readonly weight: number;
  readonly settle: (a: Acquisition) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  done: boolean;
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

  /** Events in flight allowed at once — dec-6's second term. See {@link DEFAULT_EVENT_BUDGET}. */
  readonly eventBudget: number;

  /** hashed key → slots currently held. An entry exists only while its count is > 0. */
  readonly #held = new Map<string, number>();
  #inFlight = 0;
  /** EMISSIONS in flight — the sum of admitted weights, not a request count. */
  #inFlightEvents = 0;

  /** How long a caller may be held before being refused. */
  readonly waitMs: number;
  /** How many callers may queue at once, past which the gate hard-sheds. */
  readonly maxWaiters: number;

  /** Shadow (count only) or enforcing. Exposed so t-9's smoke can assert what is running. */
  readonly mode: GateMode;

  readonly #queue: Waiter[] = [];

  constructor(options: EmissionGateOptions = {}) {
    const env = resolveWaitConfig();
    this.mode = options.mode ?? resolveGateMode();
    this.#onShed = options.onShed;
    const poolMax = options.poolMax ?? resolvePoolMax();
    this.ceiling = deriveCeiling(poolMax);
    this.perKeySlice = derivePerKeySlice(this.ceiling);
    this.maxTrackedKeys = options.maxTrackedKeys ?? MAX_TRACKED_KEYS;
    this.eventBudget = options.eventBudget ?? resolveEventBudget();
    // Clamped, never obeyed blindly — see MAX_WAIT_MS.
    this.waitMs = Math.min(options.waitMs ?? env.waitMs, MAX_WAIT_MS);
    const serviceMs = options.serviceMs ?? env.serviceMs;
    this.maxWaiters =
      options.maxWaiters ??
      env.maxWaiters ??
      deriveMaxWaiters(this.ceiling, this.waitMs, serviceMs);
  }

  /** Callers currently queued for a slot. Non-zero means the gate is contended. */
  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * What enforcing WOULD have refused, by cause. Zero outside shadow mode — an enforcing
   * gate does not count counterfactuals, it just refuses. t-5 reads this onto the shared
   * OTEL meter; ac-14's labels are the keys of `byCause`, deliberately the same
   * {@link ShedCause} vocabulary the enforcing path returns, so a week of shadow data
   * stays comparable the moment enforcement goes on.
   */
  get wouldShed(): WouldShedCount {
    return {
      events: this.#wouldShedEvents,
      requests: this.#wouldShedRequests,
      eventsByCause: { ...this.#wouldShedEventsByCause },
      requestsByCause: { ...this.#wouldShedRequestsByCause },
      ceilingOnlyEvents: this.#ceilingOnlyEvents,
      ceilingOnlyRequests: this.#ceilingOnlyRequests,
    };
  }

  readonly #onShed?: (weight: number, cause: ShedCause, waited: boolean) => void;

  /** Report a shed without letting a caller's throw escape into the request path. */
  #reportShed(weight: number, cause: ShedCause, waited: boolean): void {
    if (!this.#onShed) return;
    try {
      this.#onShed(weight, cause, waited);
    } catch {
      // Telemetry must never break admission. A counter that throws would turn every
      // shed into a 500 — the load-protection mechanism becoming the outage.
    }
  }

  #wouldShedEvents = 0;
  #wouldShedRequests = 0;
  // t-13's counterfactual: an occupancy counter that knows only the ceiling.
  #ceilingOnlyInFlight = 0;
  #ceilingOnlyEvents = 0;
  #ceilingOnlyRequests = 0;
  #wouldShedEventsByCause: Record<ShedCause, number> = zeroByCause();
  #wouldShedRequestsByCause: Record<ShedCause, number> = zeroByCause();

  // Real occupancy, tracked separately ONLY in shadow — where the caller is admitted
  // regardless of what the simulation decided, so the two diverge. In enforcing they
  // would be identical, so the gate does not keep them.
  readonly #realHeld = new Map<string, number>();
  #realInFlight = 0;
  #realInFlightEvents = 0;

  /**
   * Slots currently held across all credentials — what is ACTUALLY in flight.
   *
   * In shadow this exceeds {@link ceiling} routinely, because nothing is held back; the
   * bounded simulation is a separate set. In enforcing the two are the same thing.
   */
  get inFlight(): number {
    return this.mode === "shadow" ? this.#realInFlight : this.#inFlight;
  }

  /**
   * EMISSIONS currently in flight — dec-6's second axis, and not derivable from
   * {@link inFlight}. Two requests can be 2 events or 1 000; that difference is the
   * entire reason this term exists.
   *
   * Mirrors {@link inFlight}'s shadow/enforcing split for the same reason: in shadow the
   * caller is admitted regardless of what the simulation decided, so real occupancy and
   * simulated occupancy diverge, and the real one is what an operator is looking at.
   */
  get inFlightEvents(): number {
    return this.mode === "shadow" ? this.#realInFlightEvents : this.#inFlightEvents;
  }

  /** Distinct credentials currently holding at least one slot. */
  get trackedKeys(): number {
    return this.mode === "shadow" ? this.#realHeld.size : this.#held.size;
  }

  /**
   * Take a slot, or say why not. Answers immediately — never waits (that is t-2).
   *
   * Order matters: the per-key slice is checked FIRST so a loud credential is told it
   * filled its own share rather than that the instance is saturated. The labels drive
   * opposite operator responses, so attributing a self-inflicted refusal to instance
   * saturation would send someone to resize the wrong thing.
   */
  tryAcquire(presentedToken: string, weight = 1): Acquisition {
    const taken = this.#take(keyOf(presentedToken), weight);
    if (taken.ok) return { ok: true, release: taken.release, waited: false };
    this.#reportShed(weight, taken.cause, false);
    return { ok: false, cause: taken.cause, waited: false };
  }

  /**
   * Take a slot, waiting a bounded moment if the gate is full (dec-4).
   *
   * Three outcomes, and the difference between the last two is the whole of ac-19:
   *   - room now              → resolves immediately, `waited: false`
   *   - full, queue has space → waits up to {@link waitMs}, then served or refused
   *   - full, queue also full → refused NOW, `waited: false` (flood regime)
   *
   * Waiting is what makes the loss rate acceptable AND what keeps Cloud Run's autoscaler
   * honest: a waiting request holds its concurrency slot, so the instance looks as busy
   * as it is. A fast refusal completes in ~1 ms and makes a saturated instance look idle,
   * so it is never scaled out and keeps refusing. That is why "refuse now" is a different
   * outcome rather than a conservative version of "wait".
   */
  acquire(presentedToken: string, weight = 1): Promise<Acquisition> {
    const key = keyOf(presentedToken);
    return this.mode === "shadow"
      ? this.#admitAndSimulate(key, weight)
      : this.#decide(key, weight).then((a) => {
          if (!a.ok) this.#reportShed(weight, a.cause, a.waited);
          return a;
        });
  }

  /**
   * Shadow: let the caller through untouched, and run the full gate beside it.
   *
   * Three readings of "shadow" were available and they measure different things. Counting
   * contention at arrival is cheap but never sees the wait, so it would describe HARD shed
   * — the mechanism dec-4 rejected — and ac-2's budget would come from the wrong
   * distribution. Actually waiting and then admitting measures the truth but adds the full
   * interval to real requests, breaking the property that makes the first deploy safe.
   *
   * So the whole mechanism — bounds, queue, timeouts, the fairness rule that skips a
   * waiter whose own slice is full — runs against the gate's own counters while the caller
   * is resolved immediately. The would-shed count is the genuine counterfactual, timeouts
   * included, at zero cost to the caller.
   *
   * The simulation is deliberately NOT awaited: awaiting it would reintroduce exactly the
   * latency this design exists to avoid.
   */
  #admitAndSimulate(key: string, weight = 1): Promise<Acquisition> {
    this.#realInFlight += 1;
    this.#realInFlightEvents += weight;
    this.#realHeld.set(key, (this.#realHeld.get(key) ?? 0) + 1);

    // t-13 — the ceiling-alone counterfactual, evaluated on arrival against its OWN
    // occupancy. It cannot be derived from the counters above: a request the slice
    // refuses never occupies a simulated slot, so the primary simulation's occupancy is
    // systematically lower than a ceiling-only gate's would be.
    let ceilingOnlyHeld = false;
    if (this.#ceilingOnlyInFlight >= this.ceiling) {
      this.#ceilingOnlyEvents += weight;
      this.#ceilingOnlyRequests += 1;
    } else {
      this.#ceilingOnlyInFlight += 1;
      ceilingOnlyHeld = true;
    }

    // The simulated slot, if the simulation ends up granting one. It may resolve after the
    // caller has already released, so the two are reconciled rather than assumed ordered.
    let simRelease: (() => void) | null = null;
    let callerReleased = false;

    void this.#decide(key, weight).then((simulated) => {
      if (simulated.ok) {
        // Give the slot straight back if the real request is already finished — otherwise
        // the simulation would hold state for a request that no longer exists, and the
        // per-key map would stop being bounded by what is in flight (ac-11).
        if (callerReleased) simulated.release();
        else simRelease = simulated.release;
      } else {
        // `weight` on the event axis, 1 on the request axis. Incrementing both by 1 is
        // the defect t-12 fixed: it read as emissions and counted requests.
        this.#wouldShedEvents += weight;
        this.#wouldShedRequests += 1;
        this.#wouldShedEventsByCause[simulated.cause] += weight;
        this.#wouldShedRequestsByCause[simulated.cause] += 1;
        // Through the SAME hook the enforcing path uses, so a week of shadow data is
        // directly comparable to enforcing data on the same instrument (ac-17, ac-14).
        this.#reportShed(weight, simulated.cause, simulated.waited);
      }
    });

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      callerReleased = true;
      this.#realInFlight -= 1;
      this.#realInFlightEvents -= weight;
      // Give the counterfactual's slot back on the caller's own lifetime — in shadow the
      // caller is admitted regardless, so that IS the true occupancy duration. Leaking it
      // would drift the counter toward "refuses everything" over hours and silently argue
      // for dec-6 option A.
      if (ceilingOnlyHeld) this.#ceilingOnlyInFlight -= 1;
      const remaining = (this.#realHeld.get(key) ?? 1) - 1;
      if (remaining <= 0) this.#realHeld.delete(key);
      else this.#realHeld.set(key, remaining);
      simRelease?.();
      simRelease = null;
    };

    return Promise.resolve({ ok: true, release, waited: false });
  }

  /** The decision itself: bounds, then a bounded wait, then a refusal. */
  #decide(key: string, weight: number): Promise<Acquisition> {
    const immediate = this.#take(key, weight);
    if (immediate.ok) {
      return Promise.resolve({ ok: true, release: immediate.release, waited: false });
    }

    // Flood regime: the queue is already as deep as the gate can drain inside the
    // interval, so holding this caller would buy it a refusal it was always going to get
    // while occupying a request slot the service needs for real traffic.
    if (this.#queue.length >= this.maxWaiters) {
      return Promise.resolve({ ok: false, cause: immediate.cause, waited: false });
    }

    return new Promise<Acquisition>((resolve) => {
      const waiter: Waiter = {
        key,
        weight,
        done: false,
        settle: (a) => {
          if (waiter.done) return;
          waiter.done = true;
          clearTimeout(waiter.timer);
          const at = this.#queue.indexOf(waiter);
          if (at >= 0) this.#queue.splice(at, 1);
          resolve(a);
        },
        timer: setTimeout(() => {
          // Report the bound that is blocking it NOW, not the one that blocked it on
          // arrival — they can differ, and the label drives the operator's response.
          waiter.settle({ ok: false, cause: this.#blockingCause(key), waited: true });
        }, this.waitMs),
      };
      this.#queue.push(waiter);
    });
  }

  /** Which bound would refuse this key right now. */
  #blockingCause(key: string): ShedCause {
    return (this.#held.get(key) ?? 0) >= this.perKeySlice
      ? "key_slice_full"
      : "instance_ceiling_full";
  }

  /** The bounds check + increment, shared by the sync and waiting paths. */
  #take(
    key: string,
    weight: number,
  ): { ok: true; release: () => void } | { ok: false; cause: ShedCause } {
    const heldByKey = this.#held.get(key) ?? 0;

    if (heldByKey >= this.perKeySlice) {
      return { ok: false, cause: "key_slice_full" };
    }
    if (this.#inFlight >= this.ceiling) {
      return { ok: false, cause: "instance_ceiling_full" };
    }
    // dec-6's second term, appended LAST on purpose. Placing it ahead of the two above
    // would re-label the shadow window t-13 already read (99.0% key_slice_full / 1.0%
    // instance_ceiling_full), and that comparability is what makes the before/after ratio
    // legible without the denominator nobody has.
    if (this.#inFlightEvents + weight > this.eventBudget) {
      return { ok: false, cause: "event_budget_full" };
    }
    // Unreachable while entries are deleted at zero (size ≤ ceiling ≪ cap); the backstop
    // is here so a future change that retains state cannot grow without limit unnoticed.
    if (heldByKey === 0 && this.#held.size >= this.maxTrackedKeys) {
      return { ok: false, cause: "instance_ceiling_full" };
    }

    this.#held.set(key, heldByKey + 1);
    this.#inFlight += 1;
    this.#inFlightEvents += weight;

    // Idempotent: a middleware with an error path can plausibly release twice, and a
    // gate that decremented twice would drift OPEN under exactly the load it guards.
    //
    // On the event axis that drift is WEIGHTED — one doubled release on a 500-event batch
    // opens 500 events of room that is not there — so the events total must live inside
    // this same guard rather than beside it (ac-25).
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
      this.#inFlightEvents -= weight;
      const remaining = (this.#held.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        // Drop the entry rather than leaving a zero. This is what makes the structure's
        // size bounded by what is in flight instead of by how many credentials have ever
        // been seen — the property that survives a rotating-token flood (ac-11).
        this.#held.delete(key);
      } else {
        this.#held.set(key, remaining);
      }
      this.#pump();
    };

    return { ok: true, release };
  }

  /**
   * Hand freed capacity to the queue.
   *
   * Walks in arrival order but skips a waiter whose OWN slice is still full, because both
   * bounds must hold for a waiter exactly as they do for a fresh caller. Serving the
   * longest-waiting caller unconditionally would let a loud credential collect slots it
   * is not entitled to just by queueing first — ac-10's fairness undone by the wait.
   * Stops as soon as the instance ceiling is the blocker, since no later waiter can
   * succeed either.
   */
  #pump(): void {
    for (const waiter of [...this.#queue]) {
      if (waiter.done) continue;
      if (this.#inFlight >= this.ceiling) return;
      const taken = this.#take(waiter.key, waiter.weight);
      if (taken.ok) {
        waiter.settle({ ok: true, release: taken.release, waited: true });
      } else if (taken.cause === "instance_ceiling_full") {
        return;
      }
      // key_slice_full → this waiter cannot be served yet; try the next one.
      // event_budget_full → likewise, and for the same reason it is not a `return`: the
      // freed room may be too small for THIS waiter's batch and ample for the next one's
      // single event, so stopping the scan here would hold a servable caller behind an
      // unservable one. Head-of-line blocking on a weighted queue, which is what the
      // per-waiter weight exists to avoid.
    }
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
