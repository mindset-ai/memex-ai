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
import {
  documents,
  decisions,
  usageEvents,
  users,
  acs,
  memexes,
  namespaces,
  testEventLatest,
} from "../db/schema.js";
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
  // identityConfirmed (captured, dec-4): the user completed the identity step —
  // i.e. they placed themselves on the developer/designer/PM triangle. The signal is
  // `role_coords` being set, NOT `identity_confirmed_at`: spec-305 backfilled
  // identity_confirmed_at for every pre-existing user (so they were never force-routed
  // through onboarding), which would light this tick green without the user ever doing
  // the step. role_coords is null for those backfilled users and is written the moment
  // the identity step is completed (placing yourself, or skipping to the centered
  // default), so it faithfully means "I saved my role on the triangle" (spec-307).
  const [userRow] = await conn
    .select({ roleCoords: users.roleCoords })
    .from(users)
    .where(eq(users.id, userId));

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

  // A RESOLVED decision the user authored (dec-8) — not merely created.
  const [resolvedDecisionRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(decisions)
    .where(and(eq(decisions.actorUserId, userId), eq(decisions.status, "resolved")));

  // An acceptance criterion the user authored (dec-8).
  const [acRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(acs)
    .where(eq(acs.actorUserId, userId));

  const [connectedRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(
      and(eq(usageEvents.actorUserId, userId), eq(usageEvents.name, "mcp.connected")),
    );

  // Non-gating (spec-305 dec-7): the user's first MCP tool call drives the
  // connect-agent reward's auto-dismiss; no step gates on it.
  const [toolRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(
      and(eq(usageEvents.actorUserId, userId), eq(usageEvents.name, "mcp.tool_called")),
    );

  // acVerified (dec-8): one of the user's ACs has a latest test event of 'pass'.
  // Join the AC to its canonical ref (namespace/memex/specs/handle/acs/ac-seq —
  // identical to acs.buildAcRef) and match test_event_latest.ac_uid, the SAME key
  // the AC tab uses, so "green here" means exactly "green in the spec".
  const [verifiedRow] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(acs)
    .innerJoin(documents, eq(acs.briefId, documents.id))
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .innerJoin(
      testEventLatest,
      eq(
        testEventLatest.acUid,
        sql`${namespaces.slug} || '/' || ${memexes.slug} || '/specs/' || ${documents.handle} || '/acs/ac-' || ${acs.seq}`,
      ),
    )
    .where(and(eq(acs.actorUserId, userId), eq(testEventLatest.latestStatus, "pass")));

  return {
    identityConfirmed: userRow?.roleCoords != null,
    mcpConnected: (connectedRow?.n ?? 0) > 0,
    mcpToolCalled: (toolRow?.n ?? 0) > 0,
    hasSpec: (specRow?.n ?? 0) > 0,
    hasResolvedDecision: (resolvedDecisionRow?.n ?? 0) > 0,
    hasAc: (acRow?.n ?? 0) > 0,
    acVerified: (verifiedRow?.n ?? 0) > 0,
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
