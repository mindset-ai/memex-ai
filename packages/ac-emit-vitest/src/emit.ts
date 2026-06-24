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
 * Default: true (emit). When MEMEX_EMIT is `false`, `0`, `no`, or `off`
 * (case-insensitive), the helper skips the POST entirely. Any other value
 * (including unset and malformed) is treated as "on".
 *
 * This is the primary scale control for adopters: customers turn it off in
 * environments where they don't want emissions (e.g. developer laptops),
 * preserving the verification dashboard as a clean, low-volume signal.
 */
export function isEmissionEnabled(): boolean {
  const raw = process.env.MEMEX_EMIT;
  if (raw === undefined) return true;
  const lc = raw.toLowerCase();
  return lc !== "false" && lc !== "0" && lc !== "no" && lc !== "off";
}

/**
 * Should this specific emission be marked hidden?
 *
 * Controlled by MEMEX_HIDDEN env var (global; all emissions in this run
 * hidden) or by per-call `{ hidden: true }` option.
 *
 * Default: false (visible). Hidden emissions are recorded server-side but
 * do not move the AC's displayed verification state.
 */
export function isHidden(perCall?: boolean): boolean {
  if (perCall === true) return true;
  const raw = process.env.MEMEX_HIDDEN;
  if (!raw) return false;
  const lc = raw.toLowerCase();
  return lc === "true" || lc === "1" || lc === "yes" || lc === "on";
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

  if (isHidden(options?.hidden)) {
    payload.hidden = true;
  }

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
  if (!isEmissionEnabled()) return;

  const url = deriveEventsUrl(args.ac_uid);
  if (url === null) return;

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
      signal: AbortSignal.timeout(5000),
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
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ac-emit] POST ${url} failed for ac_uid=${args.ac_uid}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
