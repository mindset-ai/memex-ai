// Usage-events store (spec-244 t-1).
//
// The durable sink for product-engagement telemetry. Two writers land rows here:
// the POST /telemetry route (front-end track() events, source='frontend', t-2)
// and the back-end whitelist bus subscriber (source='backend', t-3). The
// forwarder (t-5) tails the table via the `forwarded_at` outbox cursor.
//
// Like the activity-log sink, every write here is ADVISORY: a failed insert is
// logged and swallowed, never thrown back into the originating request or bus
// dispatch. Telemetry must never break or block a user action (spec-244 ac-8).

import { db, type Db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import type { UsageEvent } from "../db/schema.js";

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[usage-events]", ...args);
}

// ── Environment stamp (spec-244 dec-9) ──────────────────────────────────────
// Server-derived, never client-trusted. Drives the per-env separation at the
// Mixpanel boundary (a different project token per env) AND stamps the event so
// int data is filterable even inside a project. Derived from APP_BASE_URL — the
// same per-env signal Cloud Run already gets (int.memex.ai / memex.ai) — with a
// VITEST/test short-circuit so test rows are unmistakable.
export type UsageEnv = "int" | "prod" | "local" | "test";

export function resolveEnv(env: NodeJS.ProcessEnv = process.env): UsageEnv {
  if (env.VITEST !== undefined || env.NODE_ENV === "test") return "test";
  const explicit = (env.MEMEX_ENV ?? "").trim().toLowerCase();
  if (explicit === "int" || explicit === "prod" || explicit === "local") return explicit;
  const host = (env.APP_BASE_URL ?? "").toLowerCase();
  if (host.includes("int.memex.ai")) return "int";
  if (host.includes("memex.ai")) return "prod";
  return "local";
}

// ── Record a usage event (advisory) ─────────────────────────────────────────

export type UsageEventSource = "frontend" | "backend";

export interface RecordUsageEventInput {
  /** REQUIRED tenancy scope. */
  memexId: string;
  /** WHO acted (resolved Memex user id). Null for system-originated backend events. */
  actorUserId?: string | null;
  /** The registered event name, e.g. 'spec.create_clicked' or 'document.created'. */
  name: string;
  /** Where the event was born. */
  source: UsageEventSource;
  /** Sanitised structured props — IDs / enums / counts only, never content. */
  props?: Record<string, unknown> | null;
  /** Override the environment stamp (defaults to resolveEnv()). */
  env?: UsageEnv;
  /** When the event occurred (defaults to insert time). */
  occurredAt?: Date;
}

/**
 * Persist one usage event. Advisory: any failure is logged and swallowed so the
 * originating request / bus dispatch is never affected. Returns the inserted row
 * (or null when skipped / failed) — handy for tests; production callers ignore it.
 *
 * Rows with no memexId are skipped: memex_id is NOT NULL + an FK, so a blank one
 * can never produce a valid row.
 */
export async function recordUsageEvent(
  input: RecordUsageEventInput,
  conn: Db = db,
): Promise<UsageEvent | null> {
  if (typeof input.memexId !== "string" || input.memexId.length === 0) return null;
  try {
    const [row] = await conn
      .insert(usageEvents)
      .values({
        memexId: input.memexId,
        actorUserId: input.actorUserId ?? null,
        name: input.name,
        source: input.source,
        props: input.props ?? null,
        env: input.env ?? resolveEnv(),
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      })
      .returning();
    return row ?? null;
  } catch (err) {
    log("insert failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}
