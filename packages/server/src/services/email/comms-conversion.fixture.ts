// spec-15 t-2 (dec-2) — SHARED drift-guard vector for the activation-conversion
// metric. This file is the single source of truth for the metric's drift-prone
// constants and one canonical (input → expected) scenario.
//
// THIS FILE IS MIRRORED BYTE-FOR-BYTE IN BOTH REPOS — keep them identical:
//   • memex-backstage: packages/server/src/services/comms-conversion.fixture.ts
//   • memex-ai:        packages/server/src/services/email/comms-conversion.fixture.ts
// Each repo's parity test seeds FIXTURE_SENDS and asserts its own implementation
// returns FIXTURE_EXPECTED — Backstage's measureCommsConversion and memex-ai's
// measureActivationConversion. If either implementation, or either copy of these
// constants, drifts, a test breaks. That is the entire point (dec-2). Do NOT lift
// the metric itself into @mindset-ai/db-schema: that package is schema-only
// (spec-2 dec-8); this fixture is duplicated data, not shared code.
//
// The scenario lives entirely in the "all elapsed / all in-window" regime — every
// send is far enough in the past that its success window has fully closed — so the
// windowing + in-flight layer Backstage adds are no-ops here and the per-cohort
// {sent, converted, rate} equals what the source (all-time) measureActivationConversion
// produces. That equivalence is what makes cross-implementation parity meaningful.

export type ActivationCohort = "connected_inactive" | "signed_in_dormant";

/** Cohort → stable comms_log key. Drift surface #1. */
export const PINNED_ACTIVATION_COMMS_KEY: Record<ActivationCohort, string> = {
  connected_inactive: "activation.connected_inactive",
  signed_in_dormant: "activation.signed_in_dormant",
};

/** Cohort → success window in hours. Drift surface #2. */
export const PINNED_SUCCESS_WINDOW_HOURS: Record<ActivationCohort, number> = {
  connected_inactive: 24,
  signed_in_dormant: 48,
};

/**
 * "Spec created" is sourced from the documents table (doc_type='spec', is_demo=false),
 * NEVER a usage_events proxy. Drift surface #3 — documented here so the mirror carries
 * it explicitly even though it is asserted structurally (the scenario proves it).
 */
export const PINNED_SPEC_SOURCE = {
  table: "documents",
  docType: "spec",
  isDemo: false,
} as const;

export interface FixtureSend {
  cohort: ActivationCohort;
  /** Whole days before the reference NOW that the email was sent. */
  sentDaysAgo: number;
  /** Funnel events for this recipient, at N hours after the send. */
  events: { name: string; hoursAfterSend: number }[];
  /** Specs authored by this recipient, at N hours after the send. */
  specs: { hoursAfterSend: number; isDemo: boolean }[];
}

// Canonical scenario — one recipient per send.
export const FIXTURE_SENDS: FixtureSend[] = [
  // Email 1 (connected_inactive): 3 sent, 2 convert on a mcp.tool_called ≤24h, 1 never.
  { cohort: "connected_inactive", sentDaysAgo: 20, events: [{ name: "mcp.tool_called", hoursAfterSend: 3 }], specs: [] },
  { cohort: "connected_inactive", sentDaysAgo: 20, events: [{ name: "mcp.tool_called", hoursAfterSend: 12 }], specs: [] },
  { cohort: "connected_inactive", sentDaysAgo: 20, events: [], specs: [] },
  // Email 2 (signed_in_dormant): 3 sent, 1 converts on mcp.connected AND a non-demo
  // spec ≤48h; connected-only and spec-only do NOT convert.
  {
    cohort: "signed_in_dormant",
    sentDaysAgo: 20,
    events: [{ name: "mcp.connected", hoursAfterSend: 2 }],
    specs: [{ hoursAfterSend: 5, isDemo: false }],
  },
  { cohort: "signed_in_dormant", sentDaysAgo: 20, events: [{ name: "mcp.connected", hoursAfterSend: 2 }], specs: [] },
  { cohort: "signed_in_dormant", sentDaysAgo: 20, events: [], specs: [{ hoursAfterSend: 5, isDemo: false }] },
];

/** Hand-computed per-cohort result for FIXTURE_SENDS. */
export const FIXTURE_EXPECTED: Record<ActivationCohort, { sent: number; converted: number; rate: number }> = {
  connected_inactive: { sent: 3, converted: 2, rate: 2 / 3 },
  signed_in_dormant: { sent: 3, converted: 1, rate: 1 / 3 },
};
