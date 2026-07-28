import { readAutoActor } from "./actor.js";
import { deriveEventsUrl } from "./derive-url.js";
import { buildMetadata } from "./metadata.js";
import type { AcEventPayload, TagAcOptions } from "./types.js";

/**
 * A reference to `fetch` bound ONCE at module load — before any test can replace
 * the global (spec-302). Production emissions (driven from `setup.ts`) send
 * through this, so a consumer test that stubs `globalThis.fetch` and never
 * restores it cannot silently swallow the emission POST. The setupFile that
 * imports this module is loaded once at worker init, before any `it()` runs, so
 * the capture is guaranteed to be the genuine `fetch`.
 *
 * `emit()`'s `transport` parameter defaults to the *live* `globalThis.fetch` (not
 * this captured ref) so the emitter's own unit tests keep mocking via
 * `vi.stubGlobal('fetch', …)`; production opts into immunity by passing
 * `capturedFetch` explicitly.
 */
export const capturedFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/**
 * Should the helper emit at all? Controlled by MEMEX_EMIT.
 *
 * Default: true (emit) — and emitting is the celebrated default (spec-404), not a
 * thing to avoid. A keyed local or coding-agent run SHOULD emit: that is how a
 * Spec's board comes alive — its acceptance criteria tick green and the
 * passing-test count rises in real time as the work lands. Events landing on the
 * canonical (prod) board are the design, not pollution.
 *
 * When MEMEX_EMIT is `false`, `0`, `no`, or `off` (case-insensitive), the helper
 * skips the POST entirely. Any other value (including unset and malformed) is
 * treated as "on".
 *
 * `MEMEX_EMIT=false` is a NARROW escape for the few environments that genuinely
 * cannot or must not emit — a CI job with no key (e.g. a dependabot or fork PR
 * that receives no repo secrets), a fully offline sandbox, or a deliberate dry
 * run — NOT routine developer hygiene. Turning it off "to keep the board clean"
 * or "so dev runs don't spam prod" is the exact category error spec-404 exists to
 * kill: your emissions ARE the verification signal, so silencing them only leaves
 * real passing tests invisible while the Spec sits at 0% verified. The fix for a
 * 401 is to provision a real key (provision_ac_emission), never to disable
 * emission or redirect the destination.
 */
export function isEmissionEnabled(): boolean {
  const raw = process.env.MEMEX_EMIT;
  if (raw === undefined) return true;
  const lc = raw.toLowerCase();
  return lc !== "false" && lc !== "0" && lc !== "no" && lc !== "off";
}

/**
 * The per-Memex emission key, read from MEMEX_EMIT_KEY (spec-129).
 *
 * When set, emit() attaches it as `Authorization: Bearer <key>` on every POST so the
 * destination can authenticate the emission. When unset (or blank), no Authorization
 * header is sent — the request still goes out and, once the server enforces keys, is
 * rejected 401, which emit() swallows (see below). A missing key therefore never fails
 * the test run; it just means the emission won't be recorded.
 *
 * Generate a key in Memex settings (Emission Keys) and set it in CI:
 *   MEMEX_EMIT_KEY=mxk_… npm test
 */
export function readEmissionKey(): string | undefined {
  const raw = process.env.MEMEX_EMIT_KEY;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface EmitArgs {
  ac_uid: string;
  status: "pass" | "fail" | "error";
  test_identifier: string;
  duration_ms: number;
  options?: TagAcOptions;
}

/**
 * Build the wire-format payload for an emission.
 *
 * Exported for testing and for adopters who want to inspect the payload
 * before sending. Production code calls emit() directly.
 */
export function buildPayload({
  ac_uid,
  status,
  test_identifier,
  duration_ms,
  options,
}: EmitArgs): AcEventPayload {
  const payload: AcEventPayload = {
    ac_uid,
    status,
    test_identifier,
    duration_ms,
  };

  // spec-115 dec-6: actor is a top-level wire-format field, not a metadata
  // key. Read from the documented env-var fallback chain; omit the field
  // entirely when no env var is set (so the server stores NULL rather than
  // an empty string).
  const actor = readAutoActor();
  if (actor) {
    payload.actor = actor;
  }

  // spec-358: the emitter no longer sends a `hidden` field. Every real result
  // counts; the server no longer honours an inbound `hidden`, so there is
  // nothing to send. MEMEX_HIDDEN and the per-call `hidden` option are gone.

  const metadata = buildMetadata(options?.metadata);
  if (Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  }

  return payload;
}

/**
 * POST one emission to the Memex test-events endpoint.
 *
 * `transport` is the HTTP sender, defaulting to the live `globalThis.fetch` so
 * unit tests can mock it via `vi.stubGlobal`. Production callers (`setup.ts`)
 * pass `capturedFetch` to be immune to later global-fetch replacement (spec-302).
 */
export async function emit(
  args: EmitArgs,
  transport: typeof fetch = globalThis.fetch,
): Promise<void> {
  await emitOnce(args, transport);
}

/**
 * What one emission did. `emit()` deliberately discards this — its documented
 * contract is `Promise<void>` that never throws, and the `ac-emission-bootstrap`
 * topic describes that shape for other languages to copy, so it must not change.
 *
 * The 404 fallback needs the outcome for one reason only: a 401 means the key is
 * refused, so every remaining event in the flush will be refused too and sending
 * them is pure waste (spec-515 ac-14).
 */
type EmitOutcome = "ok" | "auth-refused" | "failed";

/** `emit()` with the outcome reported instead of swallowed. Never throws. */
async function emitOnce(
  args: EmitArgs,
  transport: typeof fetch = globalThis.fetch,
): Promise<EmitOutcome> {
  if (!isEmissionEnabled()) return "ok";

  const url = deriveEventsUrl(args.ac_uid);
  if (url === null) return "ok";

  const payload = buildPayload(args);

  // ⚠ PROTOCOL CONTRACT — the POST shape below (method, Content-Type, Authorization: Bearer
  // header, the fail-safe "swallow non-2xx + network errors" behaviour at the end of this
  // function, and surfacing the server's response body on a non-2xx) is documented
  // language-agnostically in the `ac-emission-bootstrap` get_information topic
  // (packages/server/src/guidance/ac-emission-bootstrap.json) so other languages can
  // hand-roll a correct emitter. Change the transport/auth/behaviour here → update that topic too.
  //
  // spec-129: attach the emission key as a Bearer token when MEMEX_EMIT_KEY is set.
  // Authorization is redacted for free by Cloud Run + most proxies. When unset, the POST
  // carries no Authorization header.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const emissionKey = readEmissionKey();
  if (emissionKey) {
    headers.Authorization = `Bearer ${emissionKey}`;
  }

  try {
    const res = await transport(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      // Bound the request client-side: a hung (not failed) server otherwise
      // rides the awaited fetch past vitest's 10s hookTimeout and FAILS the
      // tagged test — the one thing the fail-safe contract forbids. 5s keeps
      // well under the hook budget; the abort lands in the catch below and
      // degrades to the documented warn-and-continue.
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // spec-333: surface the server's RESPONSE BODY, not just the status code, so the
      // actionable guidance a non-2xx carries (e.g. a 401 telling a coding agent to call
      // provision_ac_emission for a fresh key) reaches the agent reading test output. The
      // body read is guarded — a failure to read it must never break the fail-safe contract
      // (a failed emission still never fails the test run).
      const responseBody = await Promise.resolve()
        .then(() => res.text())
        .catch(() => "");
      // eslint-disable-next-line no-console
      console.warn(
        `[ac-emit] POST ${url} returned ${res.status} for ac_uid=${args.ac_uid}` +
          (responseBody ? `: ${responseBody}` : ""),
      );
    }
    const warning = res.headers.get("x-memex-warning");
    if (warning) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ac-emit] server warning for ac_uid=${args.ac_uid}: ${warning}`,
      );
    }
    // 401 is the only DEFINITIVE refusal: same key, same server, so the rest of
    // the flush cannot succeed either. A 5xx is transient and per-event — treat it
    // as a plain failure so a flaky server never silently drops the whole buffer.
    if (res.status === 401) return "auth-refused";
    return res.ok ? "ok" : "failed";
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ac-emit] POST ${url} failed for ac_uid=${args.ac_uid}:`,
      err instanceof Error ? err.message : err,
    );
    return "failed";
  }
}

/**
 * How many single-event POSTs the 404 fallback may hold in flight at once
 * (spec-515 ac-13).
 *
 * Was unbounded: `Promise.all` over the whole file buffer, multiplied by however
 * many vitest workers flushed at the same moment. Observed on prod 2026-07-24 at
 * ~1,800 POSTs/min.
 *
 * The binding constraint is not CPU but the server's connection pool —
 * `DB_POOL_MAX=10` × `maxScale 3` = 30 slots, shared with real user traffic. This
 * cap is per flush and several workers can flush together, so it has to leave
 * headroom rather than merely be finite: 4 keeps even a simultaneous multi-worker
 * flush in the same order of magnitude as the pool instead of hundreds of times
 * over it. Exported so the test asserts the real value, not a copy.
 */
export const MAX_FALLBACK_CONCURRENCY = 4;

/**
 * Client-side bound on ONE request (both the batch POST and each fallback POST).
 *
 * A hung server is as dangerous as a failed one: an unbounded awaited fetch rides
 * past vitest's hook budget and fails the tagged test, which swallowing errors alone
 * cannot prevent.
 */
export const PER_REQUEST_TIMEOUT_MS = 5000;

/**
 * How long the fallback may keep STARTING new requests (spec-515 t-12 / ac-15).
 *
 * Bounding concurrency (ac-13) made total time linear in the buffer: measured at 40ms
 * per request with a cap of 4, 12 events took 144ms and 120 took 1240ms. Against a
 * HUNG server, per-request latency becomes PER_REQUEST_TIMEOUT_MS, so 120 events
 * would take 120/4 × 5s = 150 SECONDS — where the old unbounded fan-out failed the
 * same case in ~5s. Bounding alone therefore traded a connection-pool problem for a
 * guaranteed hook-timeout, which the fail-safe contract forbids.
 *
 * This deadline gates when the LAST request may start; each request is itself
 * bounded, so worst-case total ≤ 4000 + 5000 = 9s, inside vitest's 10s default
 * hookTimeout with ~1s of headroom for the rest of afterAll. Generous enough that a
 * healthy-but-slow server (200ms/request) still lands ~80 events before the cut.
 *
 * The trade-off is deliberate and asymmetric: truncating some emissions loses
 * verification signal, while overrunning the hook FAILS the consumer's test run. The
 * contract ranks those, so the deadline wins and the drop is warned about loudly.
 */
export const FALLBACK_START_DEADLINE_MS = 4000;

/**
 * Post `entries` one at a time through `emitOnce`, at most
 * {@link MAX_FALLBACK_CONCURRENCY} in flight, stopping early if the server refuses
 * the emission key.
 *
 * Never throws: `emitOnce` swallows everything, so the `Promise.all` below cannot
 * reject and the fail-safe contract survives (spec-515 ac-15 / t-12).
 */
export async function runBoundedFallback(
  entries: EmitArgs[],
  transport: typeof fetch,
  startDeadlineMs: number = FALLBACK_START_DEADLINE_MS,
): Promise<void> {
  let cursor = 0;
  let authRefused = false;
  const startedAt = Date.now();
  let deadlineHit = false;

  const worker = async (): Promise<void> => {
    while (!authRefused) {
      if (Date.now() - startedAt >= startDeadlineMs) {
        deadlineHit = true;
        return;
      }
      const index = cursor++;
      if (index >= entries.length) return;
      if ((await emitOnce(entries[index], transport)) === "auth-refused") {
        authRefused = true;
      }
    }
  };

  const width = Math.min(MAX_FALLBACK_CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: width }, () => worker()));

  if (deadlineHit) {
    const dropped = Math.max(0, entries.length - cursor);
    // eslint-disable-next-line no-console
    console.warn(
      `[ac-emit] fallback deadline (${startDeadlineMs}ms) reached — dropped ${dropped} ` +
        "of this file's events rather than overrun the test runner's hook budget. " +
        "The server has no /batch route AND is responding slowly; fix either and the " +
        "whole buffer lands in one request.",
    );
  }

  if (authRefused && cursor < entries.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ac-emit] emission key refused (401) — abandoned ${entries.length - cursor} ` +
        "of this file's remaining events rather than sending requests that cannot " +
        "succeed. Provision a fresh key (provision_ac_emission) and re-run.",
    );
  }
}

/**
 * POST MANY emissions to the Memex BATCH endpoint in ONE request (spec-489 G1).
 *
 * This is the durable relief for the CI-burst problem: instead of one POST per
 * tagged test (setup.ts previously awaited `emit()` in an `afterEach`), the
 * setup module buffers a file's emissions and flushes them here as a single
 * request. A suite that tags N tests then makes ~one request per test FILE, so
 * it no longer opens one server connection-pool slot per test.
 *
 * Honours the SAME fail-safe contract as `emit()`: it swallows a non-2xx
 * response AND any network / timeout error (a failed emission must never fail a
 * test run), bounds the request with a 5s `AbortSignal.timeout` (a hung server
 * must not stall the suite), and surfaces the server's response body on a
 * non-2xx. It also surfaces per-event rejections the batch endpoint reports in a
 * 200 body (e.g. a scoped-key mismatch), so the actionable 401 guidance still
 * reaches the developer (spec-333) even when batched.
 *
 * Events are grouped by their derived destination (`deriveEventsUrl`), so a file
 * that happens to tag refs in more than one namespace sends one batch per
 * destination. An entry whose ref can't be routed (malformed, no namespace) is
 * dropped, exactly as `emit()` drops it.
 *
 * `transport` defaults to the live `globalThis.fetch` for unit tests; production
 * (setup.ts) passes `capturedFetch` for spec-302 immunity.
 */
export async function emitBatch(
  entries: EmitArgs[],
  transport: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (!isEmissionEnabled()) return;
  if (entries.length === 0) return;

  // Group ENTRIES by destination base URL (deriveEventsUrl applies the namespace
  // routing table + MEMEX_TEST_EVENTS_URL override). Entries in one test file
  // normally share a namespace, so this is usually a single bucket. We keep the
  // original entries (not just payloads) so a batch that lands on a server
  // without the /batch route can fall back to per-event single POSTs.
  const byUrl = new Map<string, EmitArgs[]>();
  for (const entry of entries) {
    const url = deriveEventsUrl(entry.ac_uid);
    if (url === null) continue; // malformed ref → nothing to route, drop it
    const bucket = byUrl.get(url);
    if (bucket) bucket.push(entry);
    else byUrl.set(url, [entry]);
  }

  // spec-129: attach the emission key as a Bearer token when MEMEX_EMIT_KEY is
  // set (one key authenticates the whole batch, server-side). When unset, no
  // Authorization header — the batch is rejected once the server enforces keys,
  // which is swallowed like any other failed emission.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const emissionKey = readEmissionKey();
  if (emissionKey) {
    headers.Authorization = `Bearer ${emissionKey}`;
  }

  for (const [eventsUrl, bucket] of byUrl) {
    // The batch endpoint sits alongside the single-event route: `…/api/test-events/batch`.
    const batchUrl = `${eventsUrl}/batch`;
    const events = bucket.map((entry) => buildPayload(entry));
    try {
      const res = await transport(batchUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ events }),
        // Bound the request client-side for the same reason emit() does: a hung
        // server must abort into the catch below rather than ride past vitest's
        // hook timeout and fail the run.
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });

      // ROLLOUT SAFETY (spec-489, std-22): a 404/405 means this server has no
      // /batch route yet (an older deploy, or a self-hosted install on a prior
      // version). Fall back to the single-event endpoint so emissions still land
      // — the batch endpoint is an optimisation, never a hard dependency. The
      // /batch route itself only ever returns 200/400/401, so 404/405 is an
      // unambiguous "route absent" signal, not a per-request error.
      if (res.status === 404 || res.status === 405) {
        // spec-515 ac-13/ac-14: bounded, and abandoned early if the key is refused.
        // Was `Promise.all(bucket.map(emit))` — every event of the file at once.
        await runBoundedFallback(bucket, transport);
        continue;
      }

      if (!res.ok) {
        const responseBody = await Promise.resolve()
          .then(() => res.text())
          .catch(() => "");
        // eslint-disable-next-line no-console
        console.warn(
          `[ac-emit] batch POST ${batchUrl} returned ${res.status} for ${events.length} event(s)` +
            (responseBody ? `: ${responseBody}` : ""),
        );
      } else {
        // A 200 batch can still carry per-event rejections (partial failure).
        // Surface them so a scoped-key / boundary rejection stays loud (spec-333),
        // guarded so a body-read failure never breaks the fail-safe contract.
        const summary = (await Promise.resolve()
          .then(() => res.json())
          .catch(() => null)) as {
          rejected?: number;
          results?: Array<{ index: number; ok: boolean; error?: string }>;
        } | null;
        if (summary?.rejected && summary.rejected > 0) {
          const failures = (summary.results ?? []).filter((r) => !r.ok);
          // eslint-disable-next-line no-console
          console.warn(
            `[ac-emit] batch POST ${batchUrl}: ${summary.rejected} of ${events.length} event(s) rejected` +
              (failures.length
                ? `: ${failures.map((f) => `#${f.index} ${f.error ?? ""}`.trim()).join("; ")}`
                : ""),
          );
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ac-emit] batch POST ${batchUrl} failed for ${events.length} event(s):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
