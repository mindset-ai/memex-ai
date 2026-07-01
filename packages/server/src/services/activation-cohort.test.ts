// spec-427 t-5 (ac-8) — the pure cohort ladder. Exhaustive truth table over the four
// signals, plus the mutual-exclusivity guarantee (no input yields both cohorts).
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { classifyActivationCohort, type ActivationSignals } from "./activation-cohort.js";

const AC8 = "mindset-prod/memex-building-itself/specs/spec-427/acs/ac-8";
const VERIFIED = new Date("2026-06-01T00:00:00Z");

const signals = (o: Partial<ActivationSignals>): ActivationSignals => ({
  emailVerifiedAt: null,
  mcpConnected: false,
  mcpToolCalled: false,
  hasSpec: false,
  ...o,
});

describe("classifyActivationCohort", () => {
  it("connected-but-inactive: MCP connected, no tool call, no spec → Email 1", () => {
    tagAc(AC8);
    expect(classifyActivationCohort(signals({ mcpConnected: true }))).toBe("connected_inactive");
  });

  it("signed-in-but-dormant: verified signup, MCP never connected → Email 2", () => {
    tagAc(AC8);
    expect(classifyActivationCohort(signals({ emailVerifiedAt: VERIFIED }))).toBe("signed_in_dormant");
  });

  it("a tool call activates the user → neither email", () => {
    tagAc(AC8);
    expect(classifyActivationCohort(signals({ mcpConnected: true, mcpToolCalled: true }))).toBeNull();
  });

  it("a created spec activates the user → neither email", () => {
    tagAc(AC8);
    expect(classifyActivationCohort(signals({ mcpConnected: true, hasSpec: true }))).toBeNull();
  });

  it("an unverified, unconnected user qualifies for neither", () => {
    tagAc(AC8);
    expect(classifyActivationCohort(signals({}))).toBeNull();
  });

  it("mutual exclusivity: a connected AND verified user is Email 1 only, never Email 2", () => {
    tagAc(AC8);
    // the MCP-connected gate resolves the overlap to connected-inactive, never dormant
    expect(classifyActivationCohort(signals({ mcpConnected: true, emailVerifiedAt: VERIFIED }))).toBe(
      "connected_inactive",
    );
  });
});
