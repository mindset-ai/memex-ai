// Post-deploy smoke warm-up (std-17 / spec-243 smoke robustness).
//
// The smoke suite runs immediately after a new Cloud Run revision rolls. The
// FIRST real request hits a cold instance and can take well over the 30s test
// timeout — which is exactly how the authed MCP journeys (create→read→delete,
// section lifecycle over /mcp) intermittently timed out and reddened an
// otherwise-fine deploy (e.g. the spec-278 merge: tests green, deploy red purely
// on cold-start smoke timeouts).
//
// This globalSetup runs ONCE before any smoke test: it wakes the instance and
// waits until it answers fast, so the timed journeys don't pay the cold start.
// `retry: 1` in vitest.smoke.config.ts is the backstop for the rare case where a
// single warm-up pass isn't enough (or the instance scaled back down).

import { SMOKE_BASE_URL } from "./smoke-env.js";

const WARMUP_BUDGET_MS = 120_000; // total time we'll spend waking + warming
const PER_REQUEST_MS = 35_000; // generous: a cold instance can take >30s to first-respond
const WARM_THRESHOLD_MS = 3_000; // a health response under this = instance is hot
const POLL_GAP_MS = 2_000;

async function probe(path: string): Promise<{ ok: boolean; ms: number; status: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${SMOKE_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(PER_REQUEST_MS),
    });
    return { ok: true, ms: Date.now() - t0, status: res.status };
  } catch {
    return { ok: false, ms: Date.now() - t0, status: 0 };
  }
}

export default async function warmup(): Promise<void> {
  // Targeting a local dev server has no cold start — skip so a bare
  // `vitest --config vitest.smoke.config.ts` against localhost stays instant.
  if (/localhost|127\.0\.0\.1/.test(SMOKE_BASE_URL)) return;

  const deadline = Date.now() + WARMUP_BUDGET_MS;
  let warm = false;
  while (Date.now() < deadline) {
    // The first call may be the slow cold one (it wakes the instance); a later
    // call returning fast confirms the instance is hot for the imminent journeys.
    const health = await probe("/api/health");
    if (health.ok && health.status === 200 && health.ms < WARM_THRESHOLD_MS) {
      warm = true;
      console.log(`[smoke-warmup] ${SMOKE_BASE_URL} warm (health 200 in ${health.ms}ms) — running smoke.`);
      break;
    }
    console.log(
      `[smoke-warmup] ${SMOKE_BASE_URL} not hot yet (health ${health.status} in ${health.ms}ms) — waiting…`,
    );
    await new Promise((r) => setTimeout(r, POLL_GAP_MS));
  }
  // Also nudge the /mcp route — an unauthenticated 401 is fine; it still warms
  // that handler/SSE path, which the authed MCP journeys exercise next.
  await probe("/mcp");
  if (!warm) {
    console.log(
      `[smoke-warmup] ${SMOKE_BASE_URL} did not confirm hot within ${WARMUP_BUDGET_MS}ms — ` +
        `running smoke anyway (retry:1 is the backstop). A persistently slow host is a real signal.`,
    );
  }
}
