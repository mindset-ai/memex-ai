// Activity-log sink (Pulse — b-60, t-3).
//
// A single bus subscriber that persists EVERY ChangeEvent to the `activity_log`
// table as one immutable row. This is the canonical history that the Pulse
// dashboard renders as a chronological timeline.
//
// Division of labour (dec-1): the narrative is composed UPSTREAM at the capture
// site and ships on the event as `event.narrative`. The sink does NO business
// derivation — it just maps fields and persists. The only "deriving" it does is
// the structural mapping below (actor_kind from channel, NOT-NULL fallbacks)
// needed to satisfy the table's constraints when an upstream capture site hasn't
// landed yet.
//
// Robustness (requirement 5): persistence is ADVISORY. A failed insert must
// never throw back into the emitter — bus.emit() iterates subscribers and a
// throw here would be caught by the bus, but we additionally never let an
// awaited insert reject into the synchronous dispatch path. We log + swallow so
// the originating mutation/read is never affected by a logging failure.

import { and, desc, eq, lt } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { activityLog } from "../db/schema.js";
import type { ActivityLog, ActivityLogInsert } from "../db/schema.js";
import { bus, type ChangeEvent, type Unsubscribe } from "./bus.js";

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[activity-log]", ...args);
}

// ── Channel → actor_kind ────────────────────────────────────────────────
// WHO acted, derived from the surface the activity arrived THROUGH:
//   rest_ui      → human        (a person clicking in the React UI)
//   mcp          → mcp_agent    (an external agent over the MCP endpoint)
//   in_app_agent → in_app_agent (the embedded LangGraph agent)
//   server       → system       (background jobs, scans, server-internal work)
const CHANNEL_TO_ACTOR_KIND: Record<
  NonNullable<ChangeEvent["channel"]>,
  ActivityLogInsert["actorKind"]
> = {
  rest_ui: "human",
  mcp: "mcp_agent",
  in_app_agent: "in_app_agent",
  server: "system",
};

/**
 * Map a ChangeEvent onto an `activity_log` insert row. Exported for testing the
 * pure mapping in isolation (no DB). All NOT-NULL columns are derived
 * defensively so an event missing optional fields still produces a valid row:
 *
 *   - channel    : `event.channel ?? 'server'`            (NOT NULL default)
 *   - actorKind  : derived from the resolved channel       (NOT NULL)
 *   - narrative  : `event.narrative` else `"${action} ${entity}"` (NOT NULL)
 *   - memexId    : `event.memexId`                          (NOT NULL — FK)
 *   - briefId    : `event.docId ?? null`
 *   - actorUserId: `event.userId ?? null`
 *   - clientId   : `event.clientId ?? null`
 *   - entity     : `event.entity`
 *   - action     : `event.action`
 *   - payload    : `event.payload ?? null`
 */
export function mapEventToRow(event: ChangeEvent): ActivityLogInsert {
  const channel = event.channel ?? "server";
  const actorKind = CHANNEL_TO_ACTOR_KIND[channel];
  // narrative is NOT NULL — never let it be empty. Upstream composes a
  // human-readable line per dec-1; the fallback only catches capture sites that
  // haven't landed narrative yet (mutations emitted before b-60 wiring).
  const narrative =
    event.narrative && event.narrative.trim().length > 0
      ? event.narrative
      : `${event.action} ${event.entity}`;

  return {
    memexId: event.memexId,
    briefId: event.docId ?? null,
    actorUserId: event.userId ?? null,
    actorKind,
    channel,
    clientId: event.clientId ?? null,
    entity: event.entity,
    action: event.action,
    narrative,
    payload: event.payload ?? null,
  };
}

// Skip events with no memexId. memex_id is NOT NULL + an FK to memexes, so a
// blank/absent memexId can never produce a valid row. Token-lifecycle + cache
// entities (auth_token, cli_auth_request, invite_token, slack_user_cache) and
// user-scoped events flow through the bus with `memexId === ""` (std-8 §3/§6);
// those have no Memex home in the activity timeline, so we drop them rather
// than fail the insert every time.
function hasPersistableScope(event: ChangeEvent): boolean {
  return typeof event.memexId === "string" && event.memexId.length > 0;
}

/**
 * Persist one event. Advisory: any failure is logged and swallowed so the
 * originating emitter is never affected. Returns the inserted row (or null when
 * skipped / failed) — handy for tests; production callers ignore the result.
 */
export async function persistEvent(
  event: ChangeEvent,
  conn: Db = db,
): Promise<ActivityLog | null> {
  if (!hasPersistableScope(event)) return null;
  try {
    const [row] = await conn.insert(activityLog).values(mapEventToRow(event)).returning();
    return row ?? null;
  } catch (err) {
    log("insert failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}

let unsubscribe: Unsubscribe | null = null;

/**
 * Register the activity-log sink against the bus. Idempotent — a second call is
 * a no-op (returns the existing unsubscribe) so importing this module from more
 * than one place never double-writes rows.
 *
 * Wiring: the orchestrator (index.ts) calls this once at startup. DO NOT call
 * `bus.subscribe` anywhere else for activity logging.
 *
 * The bus dispatches synchronously and swallows subscriber throws (see bus.ts),
 * but we additionally fire the insert as a detached promise with its own
 * catch so a rejected insert never surfaces as an unhandled rejection and never
 * blocks the synchronous emit path.
 */
export function startActivityLogSink(): Unsubscribe {
  if (unsubscribe) return unsubscribe;
  // Default-open filter: capture EVERY event (all memexes, all entities, all
  // actions — writes AND the b-60 read actions viewed/searched/assessed/called).
  unsubscribe = bus.subscribe({}, (event) => {
    // Detached: persistEvent already swallows, but the extra .catch() guards
    // against any synchronous throw before the try/catch and keeps the bus
    // dispatch path non-blocking.
    void persistEvent(event).catch((err) => {
      log("unexpected sink error (advisory — swallowed):", err);
    });
  });
  return unsubscribe;
}

/**
 * Tear down the sink. Test-only — production registers once for the process
 * lifetime. Resets the idempotency latch so a suite can re-register.
 */
export function _stopActivityLogSink(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

// ── Query helpers ─────────────────────────────────────────────────────────

export interface ListActivityOptions {
  /** REQUIRED tenancy scope. */
  memexId: string;
  /** Max rows. Default 50, hard-capped at 200. */
  limit?: number;
  /**
   * Keyset boundary: return only rows strictly OLDER than this timestamp
   * (created_at < since). Drives "load older" pagination — pass the createdAt
   * of the last row from the previous page.
   */
  since?: Date;
  /** Filter to a single actor (human user). */
  actorUserId?: string;
  /** Filter to a single originating client. */
  clientId?: string;
  /** Filter to activity touching a single Spec. Field name `briefId` preserved as wire format under the b-105 allowlist. */
  briefId?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * List recent activity for a Memex, newest first. memexId is required; every
 * other filter is optional and AND-combined. `since` + `limit` drive keyset
 * pagination ("load older"): pass the previous page's last `createdAt` as
 * `since` to fetch the next batch.
 *
 * Backs the later GET /api/.../activity REST endpoint (t-? downstream).
 */
export async function listActivity(
  opts: ListActivityOptions,
  conn: Db = db,
): Promise<ActivityLog[]> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? DEFAULT_LIMIT)));

  const conditions = [eq(activityLog.memexId, opts.memexId)];
  if (opts.briefId !== undefined) conditions.push(eq(activityLog.briefId, opts.briefId));
  if (opts.actorUserId !== undefined)
    conditions.push(eq(activityLog.actorUserId, opts.actorUserId));
  if (opts.clientId !== undefined) conditions.push(eq(activityLog.clientId, opts.clientId));
  if (opts.since !== undefined) conditions.push(lt(activityLog.createdAt, opts.since));

  return conn
    .select()
    .from(activityLog)
    .where(and(...conditions))
    // id as a stable tiebreaker so pagination is deterministic when several rows
    // share a created_at (a burst of events in the same millisecond).
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(limit);
}
