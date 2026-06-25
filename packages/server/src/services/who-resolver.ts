// spec-122 dec-8 — the WHO resolver. Turns whatever a row carries into the
// display identity, tolerating a heterogeneous WHO: a resolved user, a free-form
// string, or an agent session. This is the resolver spec-140 deferred; spec-122
// owns it, and spec-140's ActivityRow TODO (and Pulse, t-9) consume it.
//
// Three shapes, three entry points — NO user_identities table (ac-28): the
// resolver reuses only users.email / users.name / mcp_sessions.client_name, all
// present today.
//
//  1. Authenticated users (REST UI / MCP / in-app): handled at WRITE time by the
//     denormalised actor_name column (services/actor.ts, t-2) — no read-time join
//     needed, so this file is for the cases the write path can't pre-resolve.
//  2. Free-form test_events.actor strings → resolveTestEventActor (ac-25 / ac-26).
//  3. Agent client labels → resolveAgentClientLabel (ac-27).

import { eq, or, sql, inArray } from "drizzle-orm";
import { capitalizeDisplayName } from "@memex/shared";
import { db } from "../db/connection.js";
import { users, mcpSessions } from "../db/schema.js";
import { actorName } from "./actor.js";

export interface ResolvedWho {
  /** What to render in the feed / presence line. */
  display: string;
  /**
   * The Memex user this actor resolved to, or null when it matched nobody (a CI
   * identity, an external string). Carries cross-surface unification: the same
   * user_id ties a person's CI activity to their UI activity.
   */
  userId: string | null;
}

/**
 * Resolve a free-form `test_events.actor` string to a display WHO.
 *
 * Best-effort match: email first (unique), then an UNAMBIGUOUS name match. On a
 * hit, render the user's display name and carry their user_id so their CI and UI
 * activity unify (ac-25). On a miss — or an ambiguous name — render the raw
 * string verbatim and carry no user_id: never collapsed to "You" or to a wrong
 * user (ac-26). An ambiguous name is treated as a MISS on purpose: attributing to
 * the wrong person is worse than showing the raw string.
 */
export async function resolveTestEventActor(actor: string | null | undefined): Promise<ResolvedWho> {
  const raw = (actor ?? "").trim();
  if (raw === "") return { display: "", userId: null };

  // Email match (case-insensitive; email is unique).
  const byEmail = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${raw.toLowerCase()}`)
    .limit(1);
  if (byEmail.length === 1) {
    return { display: capitalizeDisplayName(actorName(byEmail[0])), userId: byEmail[0].id };
  }

  // Exact name match — only when unambiguous (exactly one user).
  const byName = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.name, raw))
    .limit(2);
  if (byName.length === 1) {
    return { display: capitalizeDisplayName(actorName(byName[0])), userId: byName[0].id };
  }

  // Miss (or ambiguous) → verbatim, unattributed. NOT capitalized: a free-form /
  // CI identity string ("CI · abc123") is not a person name — spec-259 dec-4 scopes
  // capitalization to resolved user names, and ac-26 requires the miss render verbatim.
  return { display: raw, userId: null };
}

/**
 * Resolve an agent session's `clientId` to a friendly label of the form
 * "<user name>'s <clientName>" (e.g. "Christine's Claude Code") by joining the
 * session id → mcp_sessions.client_name and the session's user_id → users.name
 * (ac-27). Returns null when the session is unknown; falls back to the bare
 * client name when the session has no resolvable user.
 */
export async function resolveAgentClientLabel(clientId: string | null | undefined): Promise<string | null> {
  const id = (clientId ?? "").trim();
  if (id === "") return null;

  const rows = await db
    .select({
      clientName: mcpSessions.clientName,
      userName: users.name,
      userEmail: users.email,
    })
    .from(mcpSessions)
    .leftJoin(users, eq(users.id, mcpSessions.userId))
    .where(eq(mcpSessions.sessionId, id))
    .limit(1);
  if (rows.length === 0) return null;

  const { clientName, userName, userEmail } = rows[0];
  const client = clientName?.trim() || "client";
  const who = userName?.trim() || userEmail?.trim() || null;
  return who ? `${capitalizeDisplayName(who)}'s ${client}` : client;
}

/**
 * Batch variant of {@link resolveTestEventActor} for the activity view / Pulse
 * feed, which resolves many rows at once. Avoids N+1: one query over the
 * distinct non-empty actor strings, matched by email then unambiguous name.
 * Returns a Map keyed by the ORIGINAL raw string.
 */
export async function resolveTestEventActors(
  actors: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, ResolvedWho>> {
  const out = new Map<string, ResolvedWho>();
  const distinct = [...new Set(actors.map((a) => (a ?? "").trim()).filter((a) => a !== ""))];
  if (distinct.length === 0) return out;

  const lowered = distinct.map((d) => d.toLowerCase());
  const matches = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(or(inArray(sql`lower(${users.email})`, lowered), inArray(users.name, distinct)));

  const byEmail = new Map(matches.map((m) => [m.email.toLowerCase(), m]));
  // Name → count, to drop ambiguous names.
  const nameCounts = new Map<string, number>();
  for (const m of matches) if (m.name) nameCounts.set(m.name, (nameCounts.get(m.name) ?? 0) + 1);
  const byName = new Map(matches.filter((m) => m.name && nameCounts.get(m.name) === 1).map((m) => [m.name as string, m]));

  for (const raw of distinct) {
    const e = byEmail.get(raw.toLowerCase());
    if (e) { out.set(raw, { display: capitalizeDisplayName(actorName(e)), userId: e.id }); continue; }
    const n = byName.get(raw);
    if (n) { out.set(raw, { display: capitalizeDisplayName(actorName(n)), userId: n.id }); continue; }
    // Miss → verbatim (NOT capitalized; spec-259 dec-4 / ac-26).
    out.set(raw, { display: raw, userId: null });
  }
  return out;
}
