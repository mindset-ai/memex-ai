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
  eyebrow?: string;
  headline: ReactNode;
  sub?: ReactNode;
  body?: ReactNode;
  memoriam?: readonly string[];
  primary: JourneyCta;
  secondary?: JourneyCta;
  // Short label for this step in the progress map (attainment-framed).
  mapLabel?: string;
  // Render the greeting ("Hello, name") as a heading-sized line (welcome card).
  greetingHeading?: boolean;
}

export interface JourneyModule {
  id: string;
  views: Record<string, JourneyStepView>;
  // The server-derived steps (in order) a user can land on — drives the operator
  // preview control. Informational steps (navigate-only) are NOT listed here.
  milestoneStepIds: readonly string[];
  // Per-journey (dec-1): show a progress map of attained/unattained steps. Off by
  // default; onboarding turns it on. Never shown on the cold first step.
  showProgressMap?: boolean;
}
