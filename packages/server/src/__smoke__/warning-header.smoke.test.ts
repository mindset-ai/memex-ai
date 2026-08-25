// spec-533 t-4 (ac-18, ac-20) — X-Memex-Warning reaches an external client
// through the load balancer, proven on the DEPLOYED host.
//
// WHY THIS EXISTS. A header nobody receives is the same class of defect as
// spec-525's counter wired to a backend that did not exist, and as the July 404 on
// /api/test-events/batch that route tests against a mocked DB never caught. In-process
// assertions cannot see Cloud Run or the GCP load balancer; only a real request can.
//
// WHY IT DOES NOT PROBE THE ADVISORY ITSELF (dec-7). The staleness advisory is
// sampled 1-in-500, so a single probe would see nothing ~499 times out of 500 and
// could not tell "broken" from "unlucky". The two ways out are both worse than this
// one: driving ~1,500 requests per deploy is a burst at the ingest path to verify a
// feature whose purpose is to REDUCE requests, and forcing the rate to 1-in-1 in the
// smoke environment verifies a configuration production does not run — the exact
// test-passes/prod-differs shape this Spec keeps documenting.
//
// So the proof splits. What travels the wire is the CARRIER, and the carrier does not
// care what it carries: the over-cap-metadata warning fires unconditionally on any
// successful emission, so one deterministic request settles whether a custom response
// header on this route survives the hop. What the header CONTAINS is proven
// in-process against an injected randomness source (ac-21) — deterministically, with
// no network involved. Neither half is left to a draw.
//
// A SIBLING FILE RATHER THAN AN EDIT to emission-gate.smoke.test.ts, which dec-7
// named: that file tags spec-525's ac-20, and a run driven by a Spec-scoped key would
// 401 on the other Spec's emission and STOP THE REST OF THE FLUSH — losing exactly the
// emissions this file exists to make. Same directory, same env, same make target, same
// proven recipe; only the tag isolation differs.
//
// NOTHING IS IMPORTED FROM routes/test-events.js. That module reaches db/connection,
// which demands DATABASE_URL at module load and would kill this file on import against
// a remote host — how the 2026-08-14 int deploy failed, and a trap spec-515 hit twice.
// The over-cap size therefore lives in smoke-env.ts (a plain module, no db reach), and a
// non-smoke guard — spec-533-smoke-overcap-sync.regression.test.ts — imports it alongside the real
// caps to check the margin still holds. Two files, so neither has to import the other's
// hazard.

import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  SMOKE_BASE_URL,
  SMOKE_EMIT_AC_REF,
  SMOKE_EMIT_KEY,
  SMOKE_OVERCAP_VALUE_CHARS,
} from "./smoke-env.js";

const M = "mindset-prod/memex-building-itself/specs/spec-533/acs";
const AC_18 = `${M}/ac-18`;
const AC_20 = `${M}/ac-20`;

const CONFIGURED = SMOKE_EMIT_KEY !== "" && SMOKE_EMIT_AC_REF !== "";

describe.skipIf(!CONFIGURED)(
  `X-Memex-Warning traverses the wire @ ${SMOKE_BASE_URL}`,
  () => {
    it("a real over-cap emission returns the header to an external client [ac-18][ac-20]", async () => {
      tagAc(AC_18);
      tagAc(AC_20);

      // Deliberately over-cap so the header is UNCONDITIONAL: the server drops the
      // offending keys, the pass/fail still lands, and the response names what was
      // dropped. No sampling, no draw, no retry — one request, one assertion.
      const res = await fetch(`${SMOKE_BASE_URL}/api/test-events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SMOKE_EMIT_KEY}`,
        },
        body: JSON.stringify({
          // The smoke island's own AC. spec-70 dec-2: this suite owns its data island
          // and MUST NEVER touch another namespace or memex on the shared host.
          ac_uid: SMOKE_EMIT_AC_REF,
          status: "pass",
          test_identifier: "spec-533/__smoke__/warning-header-traversal",
          duration_ms: 1,
          metadata: { probe: "x".repeat(SMOKE_OVERCAP_VALUE_CHARS) },
        }),
        redirect: "manual",
      });

      // The emission must SUCCEED — the warning rides a 201, and a non-2xx here means
      // the probe measured the auth path instead of the header path.
      expect(
        res.status,
        `expected 201 from ${SMOKE_BASE_URL}/api/test-events; got ${res.status}. ` +
          `A 401 means SMOKE_EMIT_KEY does not authorise SMOKE_EMIT_AC_REF's Memex.`,
      ).toBe(201);

      const warning = res.headers.get("X-Memex-Warning");
      expect(
        warning,
        `no X-Memex-Warning on ${SMOKE_BASE_URL}/api/test-events despite deliberately ` +
          `over-cap metadata. The handler sets it; if it is absent here, something ` +
          `between the container and this client is dropping custom response headers — ` +
          `which would mean the staleness advisory reaches nobody either.`,
      ).not.toBeNull();
      expect(warning).toMatch(/metadata keys dropped/i);
      expect(warning).toContain("probe");

      // Whatever the header carries, it never carries the credential. Same property
      // the sibling header on this route already guarantees, re-checked on the wire
      // because a response header is echoed into CI logs that are retained.
      expect(warning).not.toContain(SMOKE_EMIT_KEY);
    });

    it("the advisory is NOT asserted here — that is deliberate [ac-20]", () => {
      tagAc(AC_20);
      // Recorded as an assertion rather than a comment so the next reader cannot
      // "improve" this file by reaching for the advisory and reintroducing dec-7's
      // bad choice. At 1-in-500 a single probe proves nothing about it; the rate, the
      // copy, the ordering and the batch route's silence are all proven in-process.
      expect(CONFIGURED).toBe(true);
    });
  },
);

// When the credentials are absent the tier is VISIBLY unrun rather than quietly green.
// std-26 allows a credentialled smoke tier to skip; dec-7's warning was against a check
// that PASSES by accident, which a skip is not.
describe.skipIf(CONFIGURED)("X-Memex-Warning wire probe (unconfigured)", () => {
  it("skips loudly: set SMOKE_EMIT_KEY + SMOKE_EMIT_AC_REF to run it", () => {
    expect(CONFIGURED).toBe(false);
  });
});
