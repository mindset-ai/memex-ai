// spec-303 — the ONBOARDING journey, a self-contained module (dec-1). Everything
// that defines this journey (its ordered steps and the milestone that completes
// each) lives here; the journey-state engine and the Home Canvas load journeys
// from the registry, so a journey is never interwoven into the rest of the app.
// Adding or editing a journey touches only its own module.

export type JourneyMilestone =
  | "hasSpec"
  | "hasDecision"
  | "mcpConnected"
  | "mcpToolCalled";

export interface JourneyStepDef {
  id: string;
  // The milestone that, once reached, completes this step and advances the user.
  // The terminal step has none.
  completedBy: JourneyMilestone | null;
}

export interface JourneyDef {
  id: string;
  steps: readonly JourneyStepDef[];
}

// Ordered + hard-gated: a later step is never reached before its predecessor's
// milestone is met (dec-4 / build instruction).
export const onboardingJourney: JourneyDef = {
  id: "onboarding",
  steps: [
    { id: "welcome", completedBy: "hasSpec" },
    { id: "first-decision", completedBy: "hasDecision" },
    { id: "connect-agent", completedBy: "mcpConnected" },
    { id: "use-agent", completedBy: "mcpToolCalled" },
    { id: "all-set", completedBy: null },
  ],
};
