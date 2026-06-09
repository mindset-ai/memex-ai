// spec-203 Layer 2 (dec-2): the full-vs-essence delivery decision.
//
// `claimFullHandoffDelivery` is the trigger: the full handoff rides the footer
// once per (user, session, spec, phase), re-firing on phase change (phase is in
// the key) and after the TTL idle backstop. `now` is injected so these tests are
// deterministic without touching the clock.

import { describe, it, expect, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  claimFullHandoffDelivery,
  _clearHandoffDeliveries,
  FULL_HANDOFF_TTL_MS,
} from "./handoff-delivery.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-203/acs/ac-${n}`;

const U = "user-1";
const S = "session-1";
const SPEC = "spec-1";
const T0 = 1_000_000;

describe("claimFullHandoffDelivery", () => {
  beforeEach(() => _clearHandoffDeliveries());

  it("delivers the full handoff on the first call for a (user, session, spec, phase)", () => {
    tagAc(AC(8));
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0)).toBe(true);
  });

  it("shows the essence (false) on repeat calls within the TTL", () => {
    tagAc(AC(8));
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0)).toBe(true);
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0 + 60_000)).toBe(false);
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0 + FULL_HANDOFF_TTL_MS - 1)).toBe(false);
  });

  it("re-delivers once the TTL backstop has elapsed", () => {
    tagAc(AC(8));
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0)).toBe(true);
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0 + FULL_HANDOFF_TTL_MS)).toBe(true);
    // …and the re-delivery resets the window.
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0 + FULL_HANDOFF_TTL_MS + 1)).toBe(false);
  });

  it("re-delivers when the phase changes (phase is part of the key)", () => {
    tagAc(AC(8));
    expect(claimFullHandoffDelivery(U, S, SPEC, "specify", T0)).toBe(true);
    expect(claimFullHandoffDelivery(U, S, SPEC, "specify", T0 + 1)).toBe(false);
    // Same session, same spec, new phase → fresh key → full again.
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0 + 1)).toBe(true);
  });

  it("keys per session, per user, and per spec", () => {
    tagAc(AC(8));
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0)).toBe(true);
    expect(claimFullHandoffDelivery(U, "session-2", SPEC, "build", T0)).toBe(true); // new session
    expect(claimFullHandoffDelivery("user-2", S, SPEC, "build", T0)).toBe(true); // new user
    expect(claimFullHandoffDelivery(U, S, "spec-2", "build", T0)).toBe(true); // new spec
  });

  it("isolates state between tests via _clearHandoffDeliveries", () => {
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0)).toBe(true);
    _clearHandoffDeliveries();
    expect(claimFullHandoffDelivery(U, S, SPEC, "build", T0)).toBe(true);
  });
});
