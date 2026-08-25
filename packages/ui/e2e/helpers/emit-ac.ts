// AC emission for Playwright e2e tests (spec-172). Playwright isn't wired to the
// @memex-ai-ac/vitest setup helper, so we port the wire format per the
// ac-emission discipline: POST to the ref's canonical host derived from its
// namespace (mindset-prod → memex.ai), on pass AND fail alike.
//
// The default routing IS the safety mechanism — never point this at localhost
// for a mindset-prod ref. Auth is the per-Memex MEMEX_EMIT_KEY (Bearer); a
// missing key warns server-side and the AC simply stays unverified, it never
// fails the run.

// spec-539 dec-1: provenance is DERIVED IN ONE PLACE. buildMetadata() reads the CI
// environment itself (GitHub Actions / GitLab / BuildKite / CircleCI) plus the
// MEMEX_METADATA_* convention, and is the same function the official vitest emitter
// uses — so the two paths cannot report a run differently. Do not re-derive any
// GITHUB_* variable here; that second copy was the defect this Spec fixes.
//
// ⚠ buildMetadata's parameter is EXPLICIT PER-CALL METADATA, not the environment.
// buildMetadata(process.env) merges every environment variable into the payload, and
// test_events metadata is world-readable on a public Memex [per std-31] — that would
// publish every CI runner's and every laptop's secrets. Call it with NO argument.
// ac-10's test fails the suite if an arbitrary env key ever reaches the payload.
import { buildMetadata } from "@memex-ai-ac/vitest";

const NAMESPACE_TO_BASE_URL: Record<string, string> = {
  "mindset-prod": "https://memex.ai",
  "mindset-int": "https://int.memex.ai",
};

/**
 * Emit a test_event for each AC ref. Honours MEMEX_EMIT=false/0/no/off (skip).
 * Attaches MEMEX_EMIT_KEY as a Bearer token when present.
 */
export async function emitAcEvents(
  acRefs: string[],
  status: "pass" | "fail",
  testIdentifier: string,
  durationMs: number
): Promise<void> {
  if (/^(false|0|no|off)$/i.test(process.env.MEMEX_EMIT ?? "")) return;

  const key = process.env.MEMEX_EMIT_KEY;
  // One derivation per call, shared by every ref in this batch.
  const metadata = buildMetadata();
  for (const ac_uid of acRefs) {
    const namespace = ac_uid.split("/")[0] ?? "";
    const base = NAMESPACE_TO_BASE_URL[namespace];
    if (!base) {
      // Unknown namespace — warn once-ish and skip, never fall through to localhost.
      console.warn(`[emit-ac] no canonical host for namespace "${namespace}" — skipping ${ac_uid}`);
      continue;
    }
    try {
      await fetch(`${base}/api/test-events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          ac_uid,
          status,
          test_identifier: testIdentifier,
          duration_ms: durationMs,
          actor: process.env.GITHUB_ACTOR ?? process.env.USER,
          // Omitted entirely when empty (a bare local run) rather than sent as `{}`:
          // an absent key reads as "no provenance", which is the honest answer, and
          // spec-391 dec-4's audit then correctly reports the run as local-only.
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        }),
      });
    } catch {
      // Emission must never fail the test run.
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Ergonomic fixture (spec-391 dec-6, ac-12)
// ──────────────────────────────────────────────────────────────────────────
//
// Only ~1 journey tagged ACs before this — because each had to hand-roll an
// `ACS_BY_TEST` map + a `test.afterEach` that calls emitAcEvents with the right
// file path. `installAcEmission` collapses that to one call: a journey declares
// the AC refs each test covers and the helper registers the afterEach that emits
// on pass/fail automatically (skipped tests emit nothing). This is the EMISSION
// plumbing only — journey authors (workstream D) own the journey bodies; this
// helper lives in the shared e2e helpers, file-disjoint from any journey.
//
// Usage in a journey file:
//   import { test } from "./helpers/index.js";
//   installAcEmission(test, import.meta.url, {
//     "user sees a 404 on another tenant's private spec": [`${SPEC}/acs/ac-4`],
//   });

interface PlaywrightTestLike {
  afterEach(
    fn: (args: Record<string, unknown>, testInfo: PlaywrightTestInfoLike) => unknown,
  ): void;
}

interface PlaywrightTestInfoLike {
  title: string;
  status?: string;
  duration: number;
}

/**
 * Register an afterEach on `test` that emits AC events for the current test,
 * looked up from `acsByTitle` (keyed by the test's title). `testFileUrl` is the
 * journey's `import.meta.url`, used to build a stable `test_identifier`.
 * Pass+fail both emit; skipped tests emit nothing. Emission never fails the run
 * (emitAcEvents swallows all errors).
 */
export function installAcEmission(
  test: PlaywrightTestLike,
  testFileUrl: string,
  acsByTitle: Record<string, string[]>,
): void {
  // Derive a stable identifier from the file URL (basename groups emissions per
  // journey; the full path varies by checkout).
  const fileLabel = testFileUrl.split("/").slice(-1)[0] ?? testFileUrl;
  // Playwright requires a hook callback that receives testInfo to destructure its
  // first (fixtures) argument — `async ({}, testInfo)`, never a named `_args` —
  // or it throws "First argument must use the object destructuring pattern" at
  // collection time. We take no fixtures, so destructure to an empty pattern.
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "skipped") return;
    const acRefs = acsByTitle[testInfo.title] ?? [];
    if (acRefs.length === 0) return;
    await emitAcEvents(
      acRefs,
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/${fileLabel}::${testInfo.title}`,
      testInfo.duration,
    );
  });
}
