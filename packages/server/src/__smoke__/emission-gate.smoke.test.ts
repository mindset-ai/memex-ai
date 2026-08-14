// spec-525 t-9 / ac-20 — post-deploy proof that the admission gate is MOUNTED on the
// deployed host, and running in the mode that environment intended.
//
// TWO FAILURES, BOTH SILENT WITHOUT THIS CHECK.
//
//   1. The middleware never registered. The route then behaves exactly as it did
//      before — no error, no log, just no protection. That is the class of defect
//      flat-api-mounts.ts exists for, and the July incident is the precedent: the code
//      was correct, committed and present in the running image, and the route still
//      404'd for six days.
//
//   2. The mode is not what the operator believes. Miss t-6's deploy.sh wiring and the
//      environment silently takes the code default — so a deploy can ship shadow while
//      everyone believes enforcement is on, or the reverse. This is the sharper one,
//      because the consequence surfaces days later when someone reads a shadow window
//      that never ran, or when limits nobody tuned start refusing real traffic.
//
// WHY A HEADER AND NOT A STATUS CODE (dec-5). Neither failure is visible from outside
// any other way: a shadow gate returns 200 to everything, and an enforcing gate returns
// 200 to everything too until it is under load. The same reasoning
// flat-api-reachability.smoke.test.ts applied to `{"error":"Not found"}` — six code
// paths emit it, so the status says nothing. A positive marker emitted BY the
// middleware is the only signal whose presence proves the middleware ran.
//
// Public tier: unauthenticated, non-destructive, no credentials, so it always runs
// (std-17) — deliberately NOT the credentialled tier, which std-26 allows to be skipped
// when its token is unset. dec-5 chose this mechanism partly for that reason: the check
// that matters most must not be the one most likely not to run.

import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
// From the GATE, never the middleware: the middleware reaches db/connection through
// routes/test-events.js, which demands DATABASE_URL at module load and would kill this
// file on import against a remote host — exactly how the 2026-08-14 int deploy failed,
// and the same trap spec-515 hit twice before it.
import { EMISSION_GATE_HEADER } from "../services/admission/emission-gate.js";
import { SMOKE_BASE_URL, SMOKE_ENV } from "./smoke-env.js";

const AC_MARKER = "mindset-prod/memex-building-itself/specs/spec-525/acs/ac-20";

/**
 * The mode each deployed environment is INTENDED to run.
 *
 * Both are `shadow` today: the rollout's first deploy runs shadow everywhere, and
 * enforcement is turned on later by configuration (t-10) after the window has produced
 * the numbers ac-2 requires. **When t-10 flips prod, this table is the edit that keeps
 * the smoke honest** — and a deploy that flips the secret without editing here fails,
 * which is the point. An intent nobody wrote down is not an intent the smoke can check.
 */
const INTENDED_MODE: Record<string, "shadow" | "enforcing"> = {
  int: "shadow",
  prod: "shadow",
};

describe(`emission admission gate smoke @ ${SMOKE_BASE_URL}`, () => {
  it("the gate is MOUNTED on /api/test-events — a missing registration fails the deploy", async () => {
    tagAc(AC_MARKER);
    // Unauthenticated and payload-free on purpose. The gate runs ahead of
    // authentication (ac-7), so it decides on this request before anything looks at a
    // credential — which means an unauthenticated probe is a *complete* test of the
    // mounting, not a partial one. The response status is deliberately not asserted:
    // it is a 400/401 from the route behind the gate, and asserting it would couple
    // this check to the route's error shape rather than to the gate.
    const res = await fetch(`${SMOKE_BASE_URL}/api/test-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      redirect: "manual",
    });

    const marker = res.headers.get(EMISSION_GATE_HEADER);
    // Named rather than counted, so a failure says what was actually seen.
    expect(
      marker,
      `no ${EMISSION_GATE_HEADER} on ${SMOKE_BASE_URL}/api/test-events ` +
        `(status ${res.status}) — the admission middleware is NOT mounted, and this ` +
        `host is ingesting emissions with no protection`,
    ).not.toBeNull();
  });

  it("both ingest paths are gated — /batch does not bypass", async () => {
    tagAc(AC_MARKER);
    // The highest-volume path, and the one whose mount broke before: spec-489's
    // /batch route 404'd in production for six days while every local test passed.
    const res = await fetch(`${SMOKE_BASE_URL}/api/test-events/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"events":[]}',
      redirect: "manual",
    });
    expect(
      res.headers.get(EMISSION_GATE_HEADER),
      `no ${EMISSION_GATE_HEADER} on /api/test-events/batch (status ${res.status})`,
    ).not.toBeNull();
  });

  it.skipIf(!INTENDED_MODE[SMOKE_ENV])(
    "the EFFECTIVE mode matches what this environment intended",
    async () => {
      tagAc(AC_MARKER);
      const intended = INTENDED_MODE[SMOKE_ENV];
      const res = await fetch(`${SMOKE_BASE_URL}/api/test-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        redirect: "manual",
      });

      expect(
        res.headers.get(EMISSION_GATE_HEADER),
        `${SMOKE_ENV} is running a different mode than intended. Either the ` +
          `MEMEX_EMISSION_GATE_MODE wiring in deploy.sh / deploy-config.sh was missed ` +
          `(so the environment silently took the code default), or the canonical ` +
          `memex-${SMOKE_ENV}-deploy-env secret changed without updating INTENDED_MODE ` +
          `in this file. Both are the failure t-9 exists to catch — do not "fix" it by ` +
          `editing the expectation until you know which.`,
      ).toBe(intended);
    },
  );

  it("the marker leaks nothing beyond the mode", async () => {
    tagAc(AC_MARKER);
    // dec-5 accepted a narrow disclosure on this route deliberately. "Narrow" is a
    // claim, so it is checked on the live host rather than trusted: exactly one of two
    // words, never a credential, a hash, a count, or a hostname.
    const res = await fetch(`${SMOKE_BASE_URL}/api/test-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mxk_smoke_probe_not_a_real_key",
      },
      body: "{}",
      redirect: "manual",
    });
    const marker = res.headers.get(EMISSION_GATE_HEADER);
    if (marker !== null) expect(marker).toMatch(/^(shadow|enforcing)$/);
  });
});
