// spec-303 — the user-scoped journey-state ENGINE (the "brain", dec-3/dec-4).
//
// This is generic: it loads a journey from the registry (packages/server/src/
// journeys) and derives the user's position. Position is DERIVED from the user's
// own real activity, never stored (dec-3) — so the journey self-heals (act
// anywhere and the canvas advances) with no cursor to persist, drift, or reset.
//
// Every milestone is USER-scoped — did THIS user do it — not workspace-scoped
// (dec-4), so a brand-new hire dropped into an already-busy org is still taught
// from the start. The journey is hard-gated and linear: the current step is the
// first step whose completing milestone the user has not yet met.
//
// Journey-state is a STATE SIGNAL, not an entitlement (dec-10): it reads only the
// user's own rows and touches no billing/entitlement store.

import { and, eq, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { documents, decisions, usageEvents } from "../db/schema.js";
import { activeJourney, type JourneyDef, type JourneyMilestone } from "../journeys/index.js";

export type { JourneyMilestone } from "../journeys/index.js";

export type JourneyMilestones = Record<JourneyMilestone, boolean>;

// Per-step attainment — the data a journey progress map renders. Reflects REAL
// state (so the map shows true progress even when an operator is previewing a
// different card). Because steps are independent, a later step can be attained
// while an earlier one is not (non-linear): the map makes that legible.
export interface JourneyStepStatus {
  id: string;
  attained: boolean;
}

export interface JourneyState {
  milestones: JourneyMilestones;
  currentStepId: string;
  steps: JourneyStepStatus[];
}

/** Each step's attainment from real milestones. The terminal step (no
 * `completedBy`) is attained once every milestone is met. */
export function stepStatuses(
  milestones: JourneyMilestones,
  journey: JourneyDef = activeJourney(),
): JourneyStepStatus[] {
  return journey.steps.map((s) => ({
    id: s.id,
    attained:
      s.completedBy === null
        ? journey.steps.every((st) => st.completedBy === null || milestones[st.completedBy])
        : milestones[s.completedBy],
  }));
}

/** The user's onboarding milestones — each a USER-scoped count over the acting
 * user's own rows (dec-4), with handhold demo content excluded (spec-178). */
export async function getUserMilestones(
  userId: string,
  conn: Db = db,
): Promise<JourneyMilestones> {
  const [specRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(
      and(
        eq(documents.createdByUserId, userId),
        eq(documents.docType, "spec"),
        eq(documents.isDemo, false),
      ),
    );

  const [decisionRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(decisions)
    .where(eq(decisions.actorUserId, userId));

  const [connectedRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(
      and(eq(usageEvents.actorUserId, userId), eq(usageEvents.name, "mcp.connected")),
    );

  const [toolRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(
      and(eq(usageEvents.actorUserId, userId), eq(usageEvents.name, "mcp.tool_called")),
    );

  return {
    hasSpec: (specRow?.n ?? 0) > 0,
    hasDecision: (decisionRow?.n ?? 0) > 0,
    mcpConnected: (connectedRow?.n ?? 0) > 0,
    mcpToolCalled: (toolRow?.n ?? 0) > 0,
  };
}

/** Derive the current step from real milestones (dec-3): the first step whose
 * completing milestone is unmet. Hard-gated + linear, so a later step never
 * appears before its predecessor's milestone is reached. */
export function deriveCurrentStep(
  milestones: JourneyMilestones,
  journey: JourneyDef = activeJourney(),
): string {
  for (const step of journey.steps) {
    if (step.completedBy === null) return step.id; // terminal, all milestones met
    if (!milestones[step.completedBy]) return step.id;
  }
  return journey.steps[journey.steps.length - 1].id;
}

export async function getUserJourneyState(
  userId: string,
  conn: Db = db,
): Promise<JourneyState> {
  const milestones = await getUserMilestones(userId, conn);
  const journey = activeJourney();
  return {
    milestones,
    currentStepId: deriveCurrentStep(milestones, journey),
    steps: stepStatuses(milestones, journey),
  };
}

export function isValidStepId(
  id: string,
  journey: JourneyDef = activeJourney(),
): boolean {
  return journey.steps.some((s) => s.id === id);
}
