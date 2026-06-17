// spec-303 — shared journey types (the engine contract). A journey MODULE supplies
// step views keyed by step id; the Home Canvas engine renders them. Nothing about a
// specific journey lives here.
import type { ReactNode } from 'react';

// dec-5 — a CTA names one of an allow-listed set; it never carries executable code.
export type JourneyCtaKind = 'action' | 'navigate' | 'link';

export interface JourneyCta {
  label: string;
  kind: JourneyCtaKind;
  // 'action'   → an allow-listed action id (create_spec, create_decision,
  //              connect_agent, open_specs, invite) routed to an app handler.
  // 'navigate' → a step id within the journey (in-canvas).
  // 'link'     → an external URL.
  target: string;
}

export interface JourneyStepView {
  id: string;
  eyebrow: string;
  headline: ReactNode;
  sub: ReactNode;
  body?: ReactNode;
  memoriam?: readonly string[];
  primary: JourneyCta;
  secondary?: JourneyCta;
}

export interface JourneyModule {
  id: string;
  views: Record<string, JourneyStepView>;
  // The server-derived steps (in order) a user can land on — drives the operator
  // preview control. Informational steps (navigate-only) are NOT listed here.
  milestoneStepIds: readonly string[];
}
