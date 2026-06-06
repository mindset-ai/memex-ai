// AC emission for Playwright e2e tests (spec-172). Playwright isn't wired to the
// @memex-ai-ac/vitest setup helper, so we port the wire format per the
// ac-emission discipline: POST to the ref's canonical host derived from its
// namespace (mindset-prod → memex.ai), on pass AND fail alike.
//
// The default routing IS the safety mechanism — never point this at localhost
// for a mindset-prod ref. Auth is the per-Memex MEMEX_EMIT_KEY (Bearer); a
// missing key warns server-side and the AC simply stays unverified, it never
// fails the run.

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
        }),
      });
    } catch {
      // Emission must never fail the test run.
    }
  }
}
