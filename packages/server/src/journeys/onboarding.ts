// spec-305 — the ONBOARDING journey (supersedes spec-303's v0 journey content).
// A self-contained module (spec-303 dec-1): its ordered steps and the milestone
// that completes each live here; the engine + Home Canvas load it from the registry.
//
// The journey is MCP-FIRST (spec-305 dec-3): connect the agent before creating a
// spec, because a connected agent then does the work (spec → decision → AC → green)
// while the user watches the map tick. The arc ends at a GREEN acceptance criterion,
// the aha (dec-8). Milestones are user-scoped and (except identity) derived from real
// activity; `identityConfirmed` is the one CAPTURED milestone (the role/name the user
// tells us, dec-4).

export type JourneyMilestone =
  | "identityConfirmed" // captured: the user completed the identity step (name + role)
  | "mcpConnected" // derived: the user's agent connected over MCP
  | "mcpToolCalled" // derived, NON-GATING: the user's first MCP tool call — drives the
  //                  connect-agent reward's auto-dismiss (no step gates on it)
  | "hasSpec" // derived: the user created a (non-demo) spec
  | "hasResolvedDecision" // derived: the user resolved a decision
  | "hasAc" // derived: the user added an acceptance criterion
  | "acVerified" // derived: one of the user's ACs went GREEN from a real test event
  | "planGrounded"; // derived (spec-337): the user broke the work into tasks AND has a
//                  test behind one of their ACs — the codebase-grounding signal that
//                  completes the 'Specs that match reality' step (builder-only, spec-336)

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
// milestone is met (spec-303 dec-4).
//
// `welcome` and `identity` share the `identityConfirmed` gate by design (dec-2/dec-6):
// a brand-new user lands on `welcome` (the universal Beat-1 cold open), whose CTA
// client-navigates into the `identity` form; submitting it confirms identity and
// clears BOTH at once, advancing to `connect-agent`.
export const onboardingJourney: JourneyDef = {
  id: "onboarding",
  steps: [
    { id: "welcome", completedBy: "identityConfirmed" },
    { id: "identity", completedBy: "identityConfirmed" },
    { id: "connect-agent", completedBy: "mcpConnected" },
    { id: "create-spec", completedBy: "hasSpec" },
    { id: "resolve-decision", completedBy: "hasResolvedDecision" },
    { id: "add-ac", completedBy: "hasAc" },
    { id: "see-green", completedBy: "acVerified" },
    { id: "all-set", completedBy: null },
  ],
};
