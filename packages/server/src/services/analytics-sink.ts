// AnalyticsSink — the pluggable egress interface (spec-244 dec-3).
//
// One method. The configured adapter (Mixpanel by default; Amplitude / PostHog /
// warehouse swappable) is the ONLY vendor-specific code in the egress. Producers
// (the /telemetry route, the back-end whitelist sink) never know the destination —
// they write usage_events; the forwarder reads usage_events and hands batches to
// whichever sink is configured. A self-hosted customer swaps the adapter and
// changes nothing upstream.

import type { UsageEvent } from "../db/schema.js";

export interface AnalyticsSink {
  /** Stable adapter name, for logging / metrics. */
  readonly name: string;
  /**
   * Ship a batch of usage events to the destination. MUST throw on failure so the
   * forwarder leaves forwarded_at unset and retries (at-least-once, dec-3). The
   * sink is responsible for idempotency on its side ($insert_id for Mixpanel) so a
   * retried batch does not double-count.
   */
  send(events: readonly UsageEvent[]): Promise<void>;
}
