import { test, expect, installAcEmission } from "./helpers/index.js";

// spec-391 ac-12 — live verification of the e2e AC-emission FIXTURE itself.
//
// This is NOT a journey (workstream D owns those) — it is the emission-plumbing
// owner-test for installAcEmission (spec-391 dec-6), which lets a journey
// declare the ACs each test covers and emit on pass/fail automatically. We
// register the fixture, then run a trivial always-true assertion; the fixture's
// afterEach emits a real test_event for ac-12 to the canonical host
// (mindset-prod → memex.ai). Running under `make e2e-cold` / CI (with
// MEMEX_EMIT_KEY set) is what lands the emission; the unit-level decision logic
// of the fixture is additionally covered in the fast server suite via
// tag-nothing-scan + the wire format in emit-ac.ts.

const SPEC391 = "mindset-prod/memex-building-itself/specs/spec-391";

// One call wires emission for every test in this file — the boilerplate the
// fixture exists to remove. Keyed by test title.
installAcEmission(test, import.meta.url, {
  "the installAcEmission fixture emits for a declared AC ref": [`${SPEC391}/acs/ac-12`],
});

test.describe("spec-391 — e2e AC-emission fixture, live", () => {
  test("the installAcEmission fixture emits for a declared AC ref", async () => {
    // The fixture's afterEach does the emission; this body only needs to pass so
    // the fixture posts a `pass` event for the declared ref. The assertion is a
    // smoke check that the helper imported and the test ran.
    expect(typeof installAcEmission).toBe("function");
  });
});
