// spec-337 — the "Go build" step is a TERMINAL handoff (completedBy: null), not a
// gated step, and spec-337 adds exactly ONE new milestone (planGrounded), no
// "building" count (dec-2). Verified two ways: the engine's terminal-attainment rule
// (a completedBy:null node is attained only once every prior milestone is met), and a
// source assertion that the milestone union gained planGrounded but no "building".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { stepStatuses, type JourneyMilestones } from "./journey-state.js";
import type { JourneyDef } from "../journeys/onboarding.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-337/acs/ac-${n}`;
const here = dirname(fileURLToPath(import.meta.url));

const ALL_FALSE: JourneyMilestones = {
  identityConfirmed: false,
  mcpConnected: false,
  mcpToolCalled: false,
  hasSpec: false,
  hasResolvedDecision: false,
  hasAc: false,
  acVerified: false,
  planGrounded: false,
};

describe("spec-337 — terminal 'Go build' + no 'building' milestone", () => {
  it("a terminal (completedBy:null) step is attained only once every prior milestone is met (ac-2, ac-6)", () => {
    tagAc(AC(2));
    tagAc(AC(6));
    const journey: JourneyDef = {
      id: "t",
      steps: [
        { id: "specs-match-reality", completedBy: "planGrounded" },
        { id: "go-build", completedBy: null },
      ],
    };
    // prior milestone unmet → the terminal node is NOT attained
    const notYet = stepStatuses(ALL_FALSE, journey);
    expect(notYet.find((s) => s.id === "go-build")!.attained).toBe(false);
    // prior milestone met → the terminal node IS attained (so builders reach 100%)
    const done = stepStatuses({ ...ALL_FALSE, planGrounded: true }, journey);
    expect(done.find((s) => s.id === "go-build")!.attained).toBe(true);
  });

  it("the milestone union gained planGrounded and no 'building' milestone (ac-6)", () => {
    tagAc(AC(6));
    const src = readFileSync(join(here, "..", "journeys", "onboarding.ts"), "utf8");
    expect(src).toMatch(/"planGrounded"/);
    expect(src).not.toMatch(/"building"/);
  });
});
