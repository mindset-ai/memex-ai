// Shared Pulse (b-60) front-end types.
//
// ONE row type for the whole Pulse surface. Both the live SSE stream
// (usePulseStream) and the activity history REST (usePulseHistory) speak in
// terms of `ActivityRow`, and every Pulse component (feed rows, tray tiles,
// header) imports it from here. Keep this in lockstep with the server's
// `ActivityLog` select model (packages/server/src/db/schema.ts) and the
// bus `ChangeEvent` (packages/server/src/services/bus.ts).
//
// JSON-over-the-wire note: `createdAt` is a Postgres `timestamptz` that Drizzle
// hands to Hono's `c.json(...)` as a `Date`, which serializes to an ISO-8601
// string. So on the client every row's `createdAt` is a string.

/**
 * WHO acted, derived server-side from the channel the activity arrived through.
 * Mirrors the `activity_log.actor_kind` CHECK constraint.
 */
export type ActorKind = 'human' | 'mcp_agent' | 'in_app_agent' | 'system';

/**
 * THROUGH WHAT surface the activity arrived. Mirrors the `activity_log.channel`
 * CHECK constraint.
 */
export type ActivityChannel = 'rest_ui' | 'mcp' | 'in_app_agent' | 'server';

/**
 * The entity an activity row touched. Superset string union mirroring the bus
 * `ChangeEntity`. Typed as a closed union for the common cases plus an open
 * `(string & {})` escape hatch so a new server-side entity never breaks the
 * client typecheck — Pulse renders unknown entities generically.
 */
export type ActivityEntity =
  | 'document'
  | 'section'
  | 'comment'
  | 'decision'
  | 'task'
  | 'dependency'
  | 'standard_drift'
  | 'conversation_message'
  | 'query'
  | 'tool_call'
  | 'org'
  | 'org_membership'
  | 'org_consent'
  | 'user_namespace'
  | 'memex'
  | 'share_token'
  | 'mcp_token'
  | 'user_slack_token'
  | 'waitlist_entry'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/**
 * What happened to the entity. Mutation actions (created/updated/deleted) plus
 * the b-60 read/activity actions (viewed/searched/assessed/called). Open union
 * for forward-compat, same rationale as `ActivityEntity`.
 */
export type ActivityAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'viewed'
  | 'searched'
  | 'assessed'
  | 'called'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/**
 * One row of Pulse activity. The single shape rendered across the whole Pulse
 * surface — feed rows, tray-tile change indicators, the header status line.
 *
 * Two origins produce this shape and both are normalised to it:
 *   1. The activity-history REST endpoint (GET …/activity) returns the
 *      `ActivityLog` select model verbatim — that IS an `ActivityRow`.
 *   2. The live SSE stream delivers a bus `ChangeEvent`; usePulseStream maps it
 *      onto this shape (see `changeEventToRow`) so live and historical rows are
 *      interchangeable in the UI.
 *
 * SSE-originated rows that have not yet been persisted have no DB id; the stream
 * synthesises a stable client-side id so React keys stay unique.
 */
export interface ActivityRow {
  /** DB row id (REST) or a synthesised client id for not-yet-persisted SSE rows. */
  id: string;
  /** Tenancy scope. Always present. */
  memexId: string;
  /** The Spec this activity touched, or null for memex-level / non-doc activity.
   *  Field name kept as `briefId` for wire compatibility with the server. */
  briefId: string | null;
  /** The acting human user, or null for agent/system activity. */
  actorUserId: string | null;
  /** WHO acted (derived from channel). */
  actorKind: ActorKind;
  /** THROUGH WHAT surface it arrived. */
  channel: ActivityChannel;
  /** Opaque originating-client id used to thread/attribute activity, or null. */
  clientId: string | null;
  /** The entity touched. */
  entity: ActivityEntity;
  /** What happened. */
  action: ActivityAction;
  /** Human-readable one-line summary. Always present (server backfills a fallback). */
  narrative: string;
  /** Arbitrary structured detail (search text, tool name/args summary, …), or null. */
  payload: Record<string, unknown> | null;
  /** ISO-8601 timestamp the activity was recorded. */
  createdAt: string;
}

/**
 * Live-connection health for the "● Live" status line.
 *   connecting   — first connection attempt in flight, no stream yet
 *   connected    — stream open and a heartbeat seen within the last 30s
 *   reconnecting — the stream dropped and a backoff retry is in flight
 *   dead         — >30s without any heartbeat/event on an otherwise-open stream
 */
export type PulseConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'dead';
