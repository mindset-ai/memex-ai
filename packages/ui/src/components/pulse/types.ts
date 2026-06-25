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
  /**
   * spec-122 ac-12 / ac-4 — the denormalised display name of WHO acted, resolved
   * server-side at write time. A human's display name ("Barrie"); an agent's
   * client label ("Claude Code (Barrie)"); or a free-form CI string ("CI · abc")
   * that matched no user. Null on rows that predate the threading — the UI then
   * falls back to the client label, NEVER to "You".
   */
  actorName: string | null;
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
 * spec-122 (dec-4, ac-1) — a single "who's here NOW" presence row, as returned
 * by `GET /api/<ns>/<mx>/presence?ref=<spec>`. The ephemeral present-tense twin
 * of {@link ActivityRow}: it says who is THERE on a spec right now (decaying
 * ~30s), not what changed. Mirrors the server's `PresentRow`
 * (packages/server/src/services/presence.ts).
 */
export interface PresentRow {
  /** Tenancy scope. */
  memexId: string;
  /** The spec doc this presence is on. */
  docId: string;
  /** The present human/agent's user id. */
  actorUserId: string;
  /** The present worker's display name ("Barrie" / "Claude Code (Barrie)"). */
  actorName: string | null;
  /** WHO is here (human vs agent). */
  actorKind: ActorKind;
  /** THROUGH WHAT surface they're here. */
  channel: ActivityChannel;
  /** Per-client discriminator (browser session / MCP session id). */
  clientId: string;
  /** ISO-8601 of the worker's most recent beat — drives "how long since". */
  lastSeenAt: string;
  /** Whether the row came from an explicit heartbeat or the passive floor. */
  source: 'heartbeat' | 'floor';
}

/**
 * spec-122 ac-1 — the "What's moving" zone shows STATE-CHANGING activity only:
 * the verbs that mean work advanced (created/updated/deleted/resolved/approved/
 * verified/…). It NEVER shows the ambient read actions (viewed/searched/assessed/
 * called) — those are a wall of low-value noise a manager glancing at the board
 * shouldn't have to wade through. We allowlist by EXCLUSION: anything that isn't
 * a known read action counts as "moving", so a new server-side mutation verb is
 * surfaced by default rather than silently dropped.
 */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'viewed',
  'searched',
  'assessed',
  'called',
]);

/** True when an activity row represents a state-changing ("moving") action. */
export function isStateChanging(row: Pick<ActivityRow, 'action'>): boolean {
  return !READ_ONLY_ACTIONS.has(row.action);
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
