// spec-336 — Home Onboarding v2: the persistent "Getting started on Memex" journey.
// (Supersedes spec-305's MCP-first 8-step arc and re-merges the whole SDD loop into one
// persistent Home tracker every newcomer sees — reversing spec-305 dec-12's "shrink to
// identity+connect, lift the rest to an on-demand walkthrough". Coordinated with Wic:
// spec-336 supersedes spec-305's journey content.)
//
// A self-contained module (spec-303 dec-1): its ordered steps and the milestone that
// completes each live here; the engine + Home Canvas load it from the registry. The six
// steps mirror the v2 design's six-node rail one-for-one (spec-336 dec-2):
//
//   1. identity            → identityConfirmed   "About you"
//   2. create-spec         → hasSpec             "Build exactly what you decided"
//                            (one card: Stage 1 connect-MCP + Stage 2 create the spec —
//                             mcpConnected is shown inside the card, but the STEP orb
//                             ticks on hasSpec)
//   3. resolve-decision    → hasResolvedDecision "No agent decides for you"
//   4. add-ac              → hasAc               "Done becomes a fact"
//   5. specs-match-reality → planGrounded        "Specs that match reality" (BUILDER-ONLY)
//   6. agents-build        → null (terminal)     "Agents build in lockstep" (BUILDER-ONLY)
//
// Every milestone stays USER-scoped and (except identity) DERIVED from real activity —
// each step's orb ticks and the % advances ONLY on real completion, never on viewing
// (spec-336 dec-5/dec-6). `identityConfirmed` is the one CAPTURED milestone (the role the
// user places on the triangle, spec-305 dec-4). The two builder-only steps' milestones
// come from spec-337 (planGrounded) and the terminal-all-met rule.
//
// Role branching is UI-SIDE (spec-336 dec-3): the server returns ALL six steps + the
// user's raw role_coords; the Home Canvas derives builder-ness from the coords via the
// shared personaLabel helper and hides the two build steps for non-builders. No
// is_builder column, no migration, no server persona port.

export type JourneyMilestone =
  | "identityConfirmed" // captured: the user placed themselves on the role triangle (name + role)
  | "mcpConnected" // derived: the user's agent completed the MCP handshake (mcp.connected).
  //                  Kept for cohorting/greeting gates; the create-spec rail step no longer
  //                  gates on it (spec-482 dec-5 — a handshake with no tool call isn't a
  //                  meaningful connection).
  | "mcpToolCalled" // derived: the user's first MCP tool call (observed MCP traffic). GATES
  //                  the create-spec "Connect MCP" rail step (spec-482 dec-5/ac-15) and drives
  //                  the connect reward's auto-dismiss.
  | "hasSpec" // derived: the user created a (non-demo) spec
  | "hasResolvedDecision" // derived: the user resolved a decision
  | "hasAc" // derived: the user added an acceptance criterion
  | "acVerified" // derived, NON-GATING: one of the user's ACs went GREEN (kept for the
  //                progress signal / spec-337 inputs; no v2 step gates on it directly)
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

// Ordered: the current step is the first whose completing milestone is unmet. A later
// step's orb can still tick before an earlier one (attainment is per-step and derived),
// which the rail makes legible (spec-303 dec-4).
//
// The two trailing steps (specs-match-reality, agents-build) are builder-only — the
// server still emits them; the Home Canvas hides them for non-builder personas
// (spec-336 dec-3). `agents-build` is terminal (completedBy: null): it ticks once every
// prior step's milestone is met (stepStatuses' all-milestones-met rule).
//
// spec-421: the old two-stage create-spec card is split into two discrete steps.
// create-spec completes on mcpConnected; create-first-spec completes on hasSpec.
// Steps 3–6 are hidden from the rail (code kept for future reintroduction).
//
// spec-482 dec-5 (ac-15): the "Connect MCP" rail step is verified INDEPENDENTLY,
// via observed MCP TRAFFIC — an `mcp.tool_called` usage_event ever recorded
// (the `mcpToolCalled` milestone) — NOT the `mcp.connected` handshake. A handshake
// with no tool call isn't a meaningful connection; the same observed-traffic
// definition the mcp-connection signal (services/mcp-connection.ts, t-2) uses.
// This is a stricter signal than the old mcpConnected gate and never keys off the
// create-first-spec landing event (hasSpec), so the two steps stay independent.
export const onboardingJourney: JourneyDef = {
  id: "onboarding",
  steps: [
    { id: "identity", completedBy: "identityConfirmed" },
    { id: "create-spec", completedBy: "mcpToolCalled" },
    { id: "create-first-spec", completedBy: "hasSpec" },
    { id: "resolve-decision", completedBy: "hasResolvedDecision" },
    { id: "add-ac", completedBy: "hasAc" },
    { id: "specs-match-reality", completedBy: "planGrounded" },
    { id: "agents-build", completedBy: null },
  ],
};
