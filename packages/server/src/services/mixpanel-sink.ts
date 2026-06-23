// Mixpanel adapter — Mindset's default analytics sink (spec-244 dec-2).
//
// A thin server-side HTTP client: NO vendor SDK, NO credential in the browser. The
// project token lives in Secret Manager → a per-env Cloud Run env var (dec-9), so
// the int service forwards to the memex-int project and prod to memex-prod simply
// by carrying a different token value. Posts to the US /track endpoint (dec-9 —
// EU residency is explicitly out of scope) with the token in properties.token
// (per the Mindset Mixpanel skill).
//
// Idempotency (dec-3): $insert_id is the usage_events row id, so an at-least-once
// retry after a Cloud Run restart cannot double-count on Mixpanel's side.

import type { UsageEvent } from "../db/schema.js";
import type { AnalyticsSink } from "./analytics-sink.js";

// US ingestion host. EU (api-eu.mixpanel.com) is deliberately not used (dec-9).
const MIXPANEL_TRACK_URL = "https://api.mixpanel.com/track";

export interface MixpanelEvent {
  event: string;
  properties: Record<string, unknown>;
}

/** Map a usage_events row to a Mixpanel /track event. Pure — unit-tested. */
export function toMixpanelEvent(row: UsageEvent, token: string): MixpanelEvent {
  const properties: Record<string, unknown> = {
    token,
    // Idempotent dedup key — survives at-least-once retries.
    $insert_id: row.id,
    // Unix seconds.
    time: Math.floor(row.occurredAt.getTime() / 1000),
    // dec-9: server-stamped env, so int is filterable even inside a project.
    env: row.env,
    // spec-297 dec-4: suppress Mixpanel's IP-based geolocation. We emit
    // server-side, so the request IP is our Cloud Run egress IP — meaningless geo
    // and incidental location data we don't want. ip="0" tells Mixpanel to skip it.
    ip: "0",
    ...(row.props ?? {}),
  };
  // Identity — Mixpanel Simplified ID Merge (spec-324, the spec-244 retrofit).
  //   - $user_id identifies an authenticated user; $device_id the anonymous
  //     browser (the spec-254 visitor_id). An event carrying BOTH merges the
  //     device's pre-identity events into the user — this is how a visitor seen
  //     BEFORE they had an identity is attributed to them once they sign in. The
  //     identity.merged event (emitted at the identify moment) carries both ids.
  //   - distinct_id stays the user UUID for an authenticated row (unchanged for
  //     the existing funnel), and "$device:<visitor_id>" for a pre-auth anonymous
  //     row, so a visitor's events land under the device until the merge resolves
  //     them. Omit entirely when neither id is present (nothing to attribute).
  if (row.visitorId) properties.$device_id = row.visitorId;
  if (row.actorUserId) {
    properties.$user_id = row.actorUserId;
    properties.distinct_id = row.actorUserId;
  } else if (row.visitorId) {
    properties.distinct_id = `$device:${row.visitorId}`;
  }
  return { event: row.name, properties };
}

export class MixpanelSink implements AnalyticsSink {
  readonly name = "mixpanel";

  constructor(
    private readonly token: string,
    // Injectable for tests; defaults to the global fetch.
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(events: readonly UsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    const payload = events.map((e) => toMixpanelEvent(e, this.token));
    const res = await this.fetchImpl(MIXPANEL_TRACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Throw so the forwarder leaves forwarded_at unset and retries (dec-3).
      throw new Error(`Mixpanel /track returned ${res.status}`);
    }
  }
}
