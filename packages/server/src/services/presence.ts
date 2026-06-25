// spec-122 t-7 (dec-4) — the ephemeral PRESENCE plane: "who's here now",
// decaying ~30s. A row counts as "here" iff last_seen_at is within the decay
// window. This is the present-tense twin of activity_log (which is durable "what
// CHANGED"); presence is "who is THERE", ephemeral.
//
// Built WRITER-AGNOSTIC (the checkpoint writer of spec-132 is On Ice, dec-9) so
// it merges two writers today:
//   1. the BROWSER HEARTBEAT — markPresent() from the REST UI (routes/presence.ts);
//   2. the PASSIVE-TELEMETRY FLOOR — derived from mcp_sessions + mcp_tool_calls
//      so a "dark" agent that emits no checkpoints still shows up present (ac-15).
//
// std-8 note: presence writes are SILENT / out-of-band. A heartbeat is not an
// activity line ("what's moving"), so markPresent does NOT go through mutate()
// and never emits on the bus (ac-17). A plain insert().onConflictDoUpdate() is
// the correct write path here.

import { and, eq, gte, sql, desc, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  presence,
  mcpSessions,
  mcpToolCalls,
  documents,
  users,
} from "../db/schema.js";
import { parseRef } from "./refs.js";
import { resolveAgentClientLabel } from "./who-resolver.js";
import { actorName } from "./actor.js";

/** The decay window — a row is "here" only if last_seen_at is within this. */
export const PRESENCE_TTL_MS = 30_000;

export type ActorKind = "human" | "mcp_agent" | "in_app_agent" | "system";
export type PresenceChannel = "rest_ui" | "mcp" | "in_app_agent" | "server";

export interface MarkPresentInput {
  memexId: string;
  docId: string;
  actorUserId: string;
  actorName?: string | null;
  actorKind: ActorKind;
  channel: PresenceChannel;
  /** Per-client discriminator (browser session id / MCP session id). */
  clientId?: string;
}

/** A presence-shaped row, whether it came from the table or the passive floor. */
export interface PresentRow {
  memexId: string;
  docId: string;
  actorUserId: string;
  actorName: string | null;
  actorKind: ActorKind;
  channel: PresenceChannel;
  clientId: string;
  lastSeenAt: Date;
  /** Where this row was derived from — useful for the UI + debugging. */
  source: "heartbeat" | "floor";
}

/** Boundary Date for "within the TTL", computed once per call. */
function ttlFloor(): Date {
  return new Date(Date.now() - PRESENCE_TTL_MS);
}

/**
 * Heartbeat write — UPSERT a single presence row keyed by
 * (doc_id, actor_user_id, channel, client_id), bumping last_seen_at to now on
 * every beat. NOT routed through mutate()/the bus (std-8 silent, ac-17).
 */
export async function markPresent(input: MarkPresentInput): Promise<void> {
  const clientId = input.clientId ?? "";
  await db
    .insert(presence)
    .values({
      memexId: input.memexId,
      docId: input.docId,
      actorUserId: input.actorUserId,
      actorName: input.actorName ?? null,
      actorKind: input.actorKind,
      channel: input.channel,
      clientId,
      // last_seen_at defaults to now() on insert; the conflict path bumps it.
    })
    .onConflictDoUpdate({
      target: [
        presence.docId,
        presence.actorUserId,
        presence.channel,
        presence.clientId,
      ],
      set: {
        lastSeenAt: sql`now()`,
        actorName: sql`excluded.actor_name`,
        actorKind: sql`excluded.actor_kind`,
      },
    });
}

/** Read the live presence-table rows (within TTL) for a single spec. */
async function tableRowsForDoc(memexId: string, docId: string): Promise<PresentRow[]> {
  const rows = await db
    .select()
    .from(presence)
    .where(
      and(
        eq(presence.memexId, memexId),
        eq(presence.docId, docId),
        gte(presence.lastSeenAt, ttlFloor()),
      ),
    )
    .orderBy(desc(presence.lastSeenAt));
  return rows.map(toHeartbeatRow);
}

/** Read the live presence-table rows (within TTL) for an entire memex. */
async function tableRowsForMemex(memexId: string): Promise<PresentRow[]> {
  const rows = await db
    .select()
    .from(presence)
    .where(and(eq(presence.memexId, memexId), gte(presence.lastSeenAt, ttlFloor())))
    .orderBy(desc(presence.lastSeenAt));
  return rows.map(toHeartbeatRow);
}

function toHeartbeatRow(r: typeof presence.$inferSelect): PresentRow {
  return {
    memexId: r.memexId,
    docId: r.docId,
    actorUserId: r.actorUserId,
    actorName: r.actorName,
    actorKind: r.actorKind as ActorKind,
    channel: r.channel as PresenceChannel,
    clientId: r.clientId,
    lastSeenAt: r.lastSeenAt,
    source: "heartbeat",
  };
}

// ── Passive-telemetry floor (ac-15) ─────────────────────────────────────────
//
// A "dark" agent session emits no presence heartbeats but is plainly still
// working, so we DERIVE presence from MCP telemetry: a session counts as "here"
// when its mcp_sessions.last_seen_at is within the TTL, OR it has a mcp_tool_call
// within the TTL in this memex. mcp_tool_calls carries no docId — the SPEC is
// resolved from the call's argsJson.ref (the canonical ref the tool acted on).
//
// Mapping (deterministic): for each session in the memex with telemetry inside
// the TTL, take its MOST RECENT tool_call (within memex+TTL) whose argsJson has a
// parseable `ref` resolving to a `specs/spec-N` handle, join to
// documents(handle, doc_type='spec') for the spec's doc_id, and emit one
// floor row per session (actor_kind='mcp_agent', channel='mcp',
// client_id=sessionId).

interface FloorCall {
  sessionId: string;
  userId: string;
  argsJson: unknown;
}

/** Pull the most-recent in-TTL tool call per session for the memex. */
async function recentToolCalls(memexId: string): Promise<FloorCall[]> {
  const floor = ttlFloor();
  // DISTINCT ON (session_id) ordered by created_at desc → newest call per session.
  const rows = await db
    .selectDistinctOn([mcpToolCalls.sessionId], {
      sessionId: mcpToolCalls.sessionId,
      userId: mcpToolCalls.userId,
      argsJson: mcpToolCalls.argsJson,
    })
    .from(mcpToolCalls)
    .where(and(eq(mcpToolCalls.memexId, memexId), gte(mcpToolCalls.createdAt, floor)))
    .orderBy(mcpToolCalls.sessionId, desc(mcpToolCalls.createdAt));
  return rows.map((r) => ({ sessionId: r.sessionId, userId: r.userId, argsJson: r.argsJson }));
}

/** Extract a parseable canonical ref string from a tool call's argsJson. */
function refFromArgs(argsJson: unknown): string | null {
  if (argsJson && typeof argsJson === "object" && "ref" in argsJson) {
    const ref = (argsJson as { ref?: unknown }).ref;
    if (typeof ref === "string" && ref.length > 0) return ref;
  }
  return null;
}

/**
 * Resolve floor presence for a memex: a map from spec doc_id → the floor rows
 * present in that spec. We resolve refs → spec handles → doc_ids in one batched
 * documents lookup. `actorName` is the agent client label
 * (resolveAgentClientLabel) falling back to the user's display name.
 */
async function floorRowsForMemex(memexId: string): Promise<PresentRow[]> {
  const calls = await recentToolCalls(memexId);
  if (calls.length === 0) return [];

  // Parse each call's ref → spec handle, keeping only the spec-typed ones.
  interface Resolvable {
    sessionId: string;
    userId: string;
    specHandle: string;
  }
  const resolvable: Resolvable[] = [];
  for (const call of calls) {
    const raw = refFromArgs(call.argsJson);
    if (!raw) continue;
    const parsed = parseRef(raw);
    if (!parsed.ok) continue;
    if (parsed.ref.docType !== "specs") continue;
    resolvable.push({
      sessionId: call.sessionId,
      userId: call.userId,
      specHandle: parsed.ref.docHandle,
    });
  }
  if (resolvable.length === 0) return [];

  // Batch-resolve the distinct spec handles → doc ids (scoped to this memex,
  // doc_type='spec').
  const handles = [...new Set(resolvable.map((r) => r.specHandle))];
  const docs = await db
    .select({ id: documents.id, handle: documents.handle })
    .from(documents)
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, "spec"),
        inArray(documents.handle, handles),
      ),
    );
  const handleToDocId = new Map(docs.map((d) => [d.handle, d.id]));

  const out: PresentRow[] = [];
  for (const r of resolvable) {
    const docId = handleToDocId.get(r.specHandle);
    if (!docId) continue;
    // Label: "<user>'s <client>" when resolvable, else the user's display name.
    const label =
      (await resolveAgentClientLabel(r.sessionId)) ?? (await userDisplayName(r.userId));
    out.push({
      memexId,
      docId,
      actorUserId: r.userId,
      actorName: label,
      actorKind: "mcp_agent",
      channel: "mcp",
      clientId: r.sessionId,
      lastSeenAt: new Date(),
      source: "floor",
    });
  }
  return out;
}

async function userDisplayName(userId: string): Promise<string | null> {
  const [u] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u ? actorName(u) : null;
}

/**
 * De-dupe presence rows per (actorUserId, clientId), preferring the heartbeat
 * row over the floor row (an explicit heartbeat is stronger signal than derived
 * telemetry), and within a source preferring the most-recent. Returns
 * most-recent first.
 */
function mergePresent(rows: PresentRow[]): PresentRow[] {
  const byKey = new Map<string, PresentRow>();
  for (const row of rows) {
    const key = `${row.actorUserId}\u0000${row.clientId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    // Heartbeat beats floor; otherwise the most-recent wins.
    const prefer =
      existing.source === row.source
        ? row.lastSeenAt > existing.lastSeenAt
        : row.source === "heartbeat";
    if (prefer) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

/**
 * Everyone "here" in a single spec — presence-table rows within TTL UNIONed with
 * the passive floor, de-duped per (actor, client), most-recent first.
 */
export async function listPresent(memexId: string, docId: string): Promise<PresentRow[]> {
  const [table, floor] = await Promise.all([
    tableRowsForDoc(memexId, docId),
    floorRowsForMemex(memexId),
  ]);
  const floorForDoc = floor.filter((r) => r.docId === docId);
  return mergePresent([...table, ...floorForDoc]);
}

/**
 * Everyone "here" across the whole memex — the same union, memex-wide (powers
 * Pulse's "Working now" zone).
 */
export async function listPresentForMemex(memexId: string): Promise<PresentRow[]> {
  const [table, floor] = await Promise.all([
    tableRowsForMemex(memexId),
    floorRowsForMemex(memexId),
  ]);
  return mergePresent([...table, ...floor]);
}
