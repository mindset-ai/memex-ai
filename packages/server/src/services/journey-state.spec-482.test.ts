// spec-482 t-11 — onboarding rail milestone semantics (dec-1, dec-5).
//
// Two independent completion signals on the rail:
//   • ac-14 — "Create your first spec" (step `create-first-spec`) completes the moment
//     the user lands on their newly created Spec: the `hasSpec` milestone ALONE, with no
//     MCP-paste / MCP-traffic evidence required.
//   • ac-15 — "Connect MCP" (step `create-spec`) is verified INDEPENDENTLY via observed
//     MCP TRAFFIC — the `mcpToolCalled` milestone (an `mcp.tool_called` usage_event), per
//     dec-5 — NOT by the landing (`hasSpec`) event and NOT by the `mcp.connected` handshake
//     (`mcpConnected`).
//
// Proven against the REAL onboardingJourney step config (not a fixture), so the test binds
// to the milestone that actually gates each rail step. Mirrors journey-state.spec-337.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { stepStatuses, type JourneyMilestones } from "./journey-state.js";
import { onboardingJourney } from "../journeys/onboarding.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-482/acs/ac-${n}`;
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

const attained = (m: JourneyMilestones, stepId: string): boolean =>
  stepStatuses(m, onboardingJourney).find((s) => s.id === stepId)!.attained;

describe("spec-482 t-11 — rail milestone semantics", () => {
  describe("ac-14 — 'Create your first spec' completes on landing (hasSpec alone)", () => {
    it("ticks the moment a spec exists, with NO MCP evidence of any kind", () => {
      tagAc(AC(14));
      // create-first-spec is gated by hasSpec — nothing else.
      const step = onboardingJourney.steps.find((s) => s.id === "create-first-spec")!;
      expect(step.completedBy).toBe("hasSpec");

      // Landed on the new Spec (hasSpec=true) with zero MCP signals → step attained.
      const landed: JourneyMilestones = { ...ALL_FALSE, hasSpec: true };
      expect(attained(landed, "create-first-spec")).toBe(true);
    });

    it("does NOT wait for any MCP-paste / MCP-traffic evidence", () => {
      tagAc(AC(14));
      // Both MCP milestones true but no spec yet → the step is NOT attained: MCP evidence
      // is neither necessary nor sufficient for this step.
      const mcpButNoSpec: JourneyMilestones = {
        ...ALL_FALSE,
        mcpConnected: true,
        mcpToolCalled: true,
        hasSpec: false,
      };
      expect(attained(mcpButNoSpec, "create-first-spec")).toBe(false);
    });
  });

  describe("ac-15 — 'Connect MCP' verified independently via observed MCP traffic (dec-5)", () => {
    it("is gated by mcpToolCalled (observed traffic), not the mcp.connected handshake", () => {
      tagAc(AC(15));
      const step = onboardingJourney.steps.find((s) => s.id === "create-spec")!;
      expect(step.completedBy).toBe("mcpToolCalled");

      // Observed MCP traffic (mcp.tool_called) completes the step.
      const traffic: JourneyMilestones = { ...ALL_FALSE, mcpToolCalled: true };
      expect(attained(traffic, "create-spec")).toBe(true);

      // The handshake ALONE (mcp.connected, no tool call) does NOT complete it — dec-5's
      // observed-traffic definition, not the handshake.
      const handshakeOnly: JourneyMilestones = { ...ALL_FALSE, mcpConnected: true };
      expect(attained(handshakeOnly, "create-spec")).toBe(false);
    });

    it("does NOT complete on the landing (hasSpec) event — the two steps are independent", () => {
      tagAc(AC(15));
      // Landing on a created Spec must not tick the Connect-MCP step.
      const landedNoTraffic: JourneyMilestones = { ...ALL_FALSE, hasSpec: true };
      expect(attained(landedNoTraffic, "create-spec")).toBe(false);
    });

    it("the create-spec rail step keys off mcpToolCalled in source (guards the UI alignment)", () => {
      tagAc(AC(15));
      // Journey def: the observed-traffic milestone gates the step.
      const journeySrc = readFileSync(join(here, "..", "journeys", "onboarding.ts"), "utf8");
      expect(journeySrc).toMatch(/id:\s*"create-spec",\s*completedBy:\s*"mcpToolCalled"/);

      // UI component reads the same observed-traffic milestone (not mcpConnected).
      const uiSrc = readFileSync(
        join(here, "..", "..", "..", "ui", "src", "components", "home", "CreateSpecStep.tsx"),
        "utf8",
      );
      expect(uiSrc).toMatch(/milestones\?\.mcpToolCalled/);
    });
  });
});
