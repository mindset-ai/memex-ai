// spec-533 t-3 — the staleness advisory carried on `X-Memex-Warning`.
//
// WHAT THIS IS FOR. A client that sends one request per tagged test costs the
// server ~8-10x the requests it needs to, and cannot be reached any other way:
// a hand-rolled emitter has no dependency range to bump, no dist-tag, and no
// package name, so no correction shipped later arrives on its own. The response
// header is the one channel that touches every client — installed, pinned or
// hand-rolled — and it already exists on both sides of the protocol, so nothing
// has to change on the client to receive this (dec-6).
//
// THE TRIGGER NEEDS NO CODE. `X-Memex-Warning` is set only on the single-event
// route; the batch route returns warnings as per-event body fields and sets no
// header at all. So a client able to receive a header-borne advisory IS, by
// construction, a client on the un-batched path, and "clients that already batch
// hear nothing" is structural rather than enforced — there is no version check to
// write, none to maintain, and none that can drift (dec-2). Do not add one: the
// current official helper sends no User-Agent and no version field, and still
// uses the legacy `ac_uid`, identically to a hand-rolled Dart emitter. Nothing on
// the wire separates old from new.

/** Reads only what it needs, so a test can pass a literal instead of mutating process.env. */
type Env = Record<string, string | undefined>;

/**
 * One response in five hundred carries the advisory.
 *
 * Chosen from the measured shape of the problem, not picked: the largest known
 * consumer emits on the order of 49,000 events a day on the un-batched path, so
 * 1-in-500 turns ~49,000 potential log lines into ~98. Returning the header on
 * every response would print one warning per test — for that consumer, roughly
 * 197,000 lines over four days. That is worse than the problem it reports and the
 * fastest possible route to the header being muted, filtered or stripped.
 *
 * The floor falls out of the same number rather than needing its own mechanism: a
 * client that sends twenty single POSTs has about a 4% chance of ever being told,
 * so the small pinned packages stay silent with no threshold implemented and no
 * state consulted. The more a client costs, the more it hears — proportionality
 * for free (dec-3).
 */
export const DEFAULT_SAMPLE_ONE_IN = 500;

export interface AdvisoryConfig {
  /** Emit the advisory on 1 response in this many. Higher is quieter. */
  readonly sampleOneIn: number;
}

/**
 * Read the rate from the environment, following the `MEMEX_EMISSION_*` convention
 * spec-525 established for this route's knobs (already threaded through
 * `packages/server/deploy.sh`), so it is retunable per environment without a code
 * change.
 *
 * Garbage and non-positive values fall back to the default rather than disabling
 * the bound. A typo must not be able to turn the advisory into a flood — the one
 * failure mode dec-3 exists to prevent.
 */
export function resolveAdvisoryConfig(env: Env = process.env): AdvisoryConfig {
  const raw = env.MEMEX_EMISSION_ADVISORY_SAMPLE_ONE_IN;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const sampleOneIn =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_ONE_IN;
  return { sampleOneIn };
}

/**
 * The advisory itself — one line, because it is an HTTP header value.
 *
 * **Every clause is load-bearing, and the version range most of all.** Under 0.x
 * caret rules `^0.2.0` cannot install ANY 0.3.x, so a reader told merely to
 * "upgrade" runs an update, sees nothing change, and believes it is fixed — the
 * defect this message reports, reproduced by the message. spec-358 dec-3 refused
 * an advisory on this same header because its recipients could not act on it;
 * actionability is the standing bar, and naming the range is what clears it.
 *
 * It also has to serve TWO populations the wire cannot distinguish: a package
 * consumer on an old pin, whose fix is a range bump, and a hand-roller with no
 * version at all, whose fix is a code change. "Bump your dependency" is wrong for
 * someone who has none.
 *
 * The pointer is an MCP tool rather than a URL, deliberately: the last pointer
 * this protocol carried was `<server>/docs/examples/`, which 404'd, and repairing
 * that is the other half of this Spec.
 *
 * No credential and nothing tenant-shaped appears here, or anywhere near it. A
 * response header is echoed into CI logs that are retained and broadly readable,
 * and the advice is about the caller's own client, so it needs no identity to be
 * useful. ASCII only, no newlines — a header value cannot carry them.
 */
export const STALENESS_ADVISORY =
  "Un-batched: this emitter sent 1 request per test (~8-10x more than needed). " +
  "Using @memex-ai-ac/vitest? set the range to ^0.3.1 - note ^0.2.0 cannot install 0.3.x. " +
  "Hand-rolled? buffer per test file and POST /api/test-events/batch. " +
  "Details: get_information(topic='ac-emission-bootstrap') items 8-10.";

// The seam that makes every claim about this advisory an assertion rather than an
// observation (ac-21). Without it, proving the rate or the message on a deployed
// host forces a choice between bursting the ingest path with ~1,500 requests per
// deploy and verifying a configuration production does not run (dec-7).
let randomSource: () => number = Math.random;

/** Test-only: drive the sampler deterministically. Pass `null` to restore Math.random. */
export function __setAdvisoryRandomForTests(fn: (() => number) | null): void {
  randomSource = fn ?? Math.random;
}

let cachedConfig: AdvisoryConfig | null = null;

/**
 * Whether THIS response carries the advisory.
 *
 * Stateless by construction: one comparison against one random draw. No database
 * query, no lock, no cache read, no coordination between instances — spec-520
 * exists to remove per-event cost from this route, and buying some back to
 * deliver an advisory would be self-defeating (std-39). The config is resolved
 * once and memoised, so not even an env read happens per request.
 *
 * **The draw is per REQUEST and must never be derived from `run_id`** — or the
 * key, or anything else constant across a run. Deriving it would make a
 * 10,000-test suite either flood or stay silent with nothing in between, which is
 * strictly worse than randomness, and it is a tempting mistake precisely because
 * the payload already carries `run_id`.
 */
export function shouldAdvise(config?: AdvisoryConfig): boolean {
  const cfg = config ?? (cachedConfig ??= resolveAdvisoryConfig());
  return randomSource() < 1 / cfg.sampleOneIn;
}

/**
 * Join the warnings that apply into ONE header value, in the order given.
 *
 * A single instance, never a second header: repeated response headers are read
 * inconsistently by the clients we know of — `fetch` comma-joins them, while
 * Dart's `HttpHeaders.value()` raises when a header carries more than one value,
 * and the Dart emitter is a real reader of this header. Its errors are swallowed,
 * so a suite would not break; the warning would simply be lost on one of the two
 * clients we can inspect.
 *
 * Callers pass the specific fact about this emission before the general advisory
 * about the client's configuration — dropped metadata keys first (dec-3).
 * spec-358 dec-3 expressly preserved that existing warning, so this composes with
 * it rather than replacing it.
 */
export function composeWarning(
  parts: readonly (string | null | undefined)[],
): string | null {
  const present = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  return present.length === 0 ? null : present.join("; ");
}
