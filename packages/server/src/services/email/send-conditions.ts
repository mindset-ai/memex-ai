// spec-493 t-1 (dec-1) — the send-condition metadata that turns the flat email preview
// into an activation timeline. This is a DEV-ONLY descriptor consumed by the preview
// surface (routes/__dev__.ts → the React gallery); it is NEVER read by the real send
// path and never sends mail.
//
// Anti-drift contract (dec-1 / ac-3 / ac-7): the facts that ALSO live in the send path —
// the dwell day-offsets and the stable comms_log keys — are IMPORTED from their source
// modules here, never re-typed as literals. If a dwell timer or comms key changes in
// activation-drip.ts / connect-people.ts, this descriptor (and the preview) follow with
// no second edit. Only the inherently-textual facts (trigger prose, cohort prose, the
// flag-gated boolean, the timeline branch) are hand-authored (ac-8) — they have no single
// machine-readable source. Per dec-1 this file does NOT modify the launch-critical send
// path; it only reads its already-exported constants.

import {
  ACTIVATION_DWELL_DAYS,
  ACTIVATION_COMMS_KEY,
  ACTIVATION_PER_COHORT_CAP,
} from "./activation-drip.js";
import { CONNECT_PEOPLE_DWELL_DAYS, CONNECT_PEOPLE_COMMS_KEY } from "./connect-people.js";

// Where an email sits on the timeline. "main" is the spine; the two cohort branches are
// mutually exclusive (classifyActivationCohort returns at most one per user), so they
// render as PARALLEL branches at the same order slot, not two sequential steps (ac-12).
export type TimelineBranch = "main" | "connected-inactive" | "win-back";

export interface SendCondition {
  /** Preview template key — matches a key in EMAIL_PREVIEW_SAMPLES. */
  template: string;
  /** Position on the timeline spine; the two cohort branches share one slot. */
  order: number;
  /**
   * Day offset from the anchor, or null for an event-driven email with no fixed day.
   * IMPORTED from the send-path dwell constants where one exists (ac-7); welcome's 0 is
   * inherent to "fires on the verification transition", not a duplicated constant.
   */
  dayOffset: number | null;
  /** Hand-authored prose: what the day offset is measured from. */
  anchor: string;
  /** Hand-authored prose: who this email targets. */
  cohort: string;
  /** Hand-authored prose: what makes it fire. */
  trigger: string;
  /** Spine vs. exclusive cohort branch. */
  branch: TimelineBranch;
  /** Held behind ACTIVATION_EMAILS_ENABLED? Welcome is transactional → false. */
  flagGated: boolean;
  /**
   * Stable comms_log dedup key, IMPORTED from the send path where an exported constant
   * exists (ac-7). null where the send path keeps the key as a private literal (welcome,
   * verified-milestone) — we deliberately do NOT re-declare it here, to avoid drift (ac-8).
   */
  commsKey: string | null;
}

// The ordered onboarding journey (dec-3). Ordering is by the timeline spine:
//   0 welcome → 1 {connected-inactive | win-back} → 2 verified-milestone → 3 connect-people
// The v1 email the signed_in_dormant cohort actually receives is the win-back
// (buildWinbackEmail — see activation-drip.buildActivationMessage), so the timeline's
// win-back branch is the "activation-winback" preview key. The superseded
// "activation-signed-in-dormant" sample is intentionally absent — it stays in the flat list.
export const ONBOARDING_SEQUENCE: readonly SendCondition[] = [
  {
    template: "welcome",
    order: 0,
    dayOffset: 0,
    anchor: "email verification",
    cohort: "every verified signup",
    trigger: "sent once, the moment a user first verifies their email",
    branch: "main",
    flagGated: false, // transactional — welcome-send.ts is NOT gated by the activation flag
    commsKey: null,
  },
  {
    template: "activation-connected-inactive",
    order: 1,
    dayOffset: ACTIVATION_DWELL_DAYS.connected_inactive,
    anchor: "first mcp.connected",
    cohort: "connected an agent, but no tool call and no spec yet",
    trigger: "dwell timer after the user first connects their agent",
    branch: "connected-inactive",
    flagGated: true,
    commsKey: ACTIVATION_COMMS_KEY.connected_inactive,
  },
  {
    template: "activation-winback",
    order: 1, // same slot as connected-inactive — the two cohorts are exclusive (ac-12)
    dayOffset: ACTIVATION_DWELL_DAYS.signed_in_dormant,
    anchor: "email verification",
    cohort: "verified, but never connected an agent",
    trigger: "dwell timer after signup for users who never connect",
    branch: "win-back",
    flagGated: true,
    commsKey: ACTIVATION_COMMS_KEY.signed_in_dormant,
  },
  {
    template: "activation-verified-milestone",
    order: 2,
    dayOffset: null, // event-driven — fires on the first verified AC, no fixed day
    anchor: "first acceptance criterion verified",
    cohort: "any user, once ever",
    trigger: "fires when the user's first AC is verified",
    branch: "main",
    flagGated: true,
    commsKey: null,
  },
  {
    template: "activation-connect-people",
    order: 3,
    dayOffset: CONNECT_PEOPLE_DWELL_DAYS,
    anchor: "signup",
    cohort: "every verified signup — independent of the cohort nudge",
    trigger: "day-12 check-in; can arrive alongside a cohort email (not exclusive)",
    branch: "main",
    flagGated: true,
    commsKey: CONNECT_PEOPLE_COMMS_KEY,
  },
];

/** The set of preview-template keys that belong on the timeline (ac-11). */
export const ONBOARDING_TEMPLATES: ReadonlySet<string> = new Set(
  ONBOARDING_SEQUENCE.map((c) => c.template),
);

/** The hard per-cohort send ceiling, surfaced from the send path (ac-7). */
export const PER_COHORT_CAP = ACTIVATION_PER_COHORT_CAP;
