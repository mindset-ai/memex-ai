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
    ...(row.props ?? {}),
  };
  // Authenticated-only capture (anonymous is a no-op), so distinct_id is the
  // acting Memex user. Omit when somehow absent rather than send a null id.
  if (row.actorUserId) properties.distinct_id = row.actorUserId;
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
    // verbose=1 makes /track return a JSON {status, error} body instead of bare
    // "1"/"0" text. This is load-bearing: /track signals an APPLICATION-level
    // rejection (bad token, malformed property, rate limit) with HTTP 200 + a
    // status:0 body — NOT a non-2xx. Without parsing the body, a rejected batch
    // looks like success and is silently dropped (forwarded_at stamped, events lost).
    const res = await this.fetchImpl(`${MIXPANEL_TRACK_URL}?verbose=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    // Transport-level failure (non-2xx).
    if (!res.ok) {
      throw new Error(`Mixpanel /track returned HTTP ${res.status}`);
    }
    // Application-level failure: throw on a non-1 status so the forwarder leaves
    // forwarded_at NULL and retries (dec-3), rather than stamping a lost batch as
    // delivered.
    const body = (await res.json().catch(() => null)) as { status?: number; error?: string } | null;
    if (!body || body.status !== 1) {
      throw new Error(
        `Mixpanel /track rejected the batch (status ${body?.status ?? "?"}): ${body?.error ?? "unknown"}`,
      );
    }
  }
}
