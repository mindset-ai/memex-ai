// spec-122 dec-5 / dec-8 — the one place that turns an authenticated user into
// the activity contract's WHO. Centralises the `user.name ?? user.email` snapshot
// that was previously hand-written inline (e.g. routes/acs.ts, routes/share.ts,
// agent/tool-specs.ts) — the "captureActor pattern" the narrative cites but which
// never existed as a symbol.
//
// The display name is DENORMALISED at write time (stamped onto the row's
// actor_name column) so the activity view and Pulse render with no read-time
// join, and a later user rename/delete can't rewrite the historical attribution
// (ac-10). The WHO resolver (dec-8, t-5) handles the read-time cases the write
// path can't — free-form test_events.actor strings and agent client labels.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import type { RequestCtx } from "./mutate.js";

/** The user fields the contract needs — kept structural so any users-row shape fits. */
export interface ActorUser {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/**
 * The denormalised display snapshot: the user's name, or their email when the
 * name is unset/blank. This is what lands in actor_name and renders verbatim in
 * the feed for the common (authenticated) case.
 */
export function actorName(user: Pick<ActorUser, "name" | "email">): string {
  const name = user.name?.trim();
  return name && name.length > 0 ? name : user.email;
}

/**
 * Build a RequestCtx that carries the full activity contract (WHO + HOW) from an
 * authenticated user at an entry point. `channel` is the surface the write
 * originated on; `clientId` the per-client discriminator (session / connection id).
 */
export function actorCtx(
  user: ActorUser,
  channel: NonNullable<RequestCtx["channel"]>,
  clientId?: string,
): RequestCtx {
  return {
    actorUserId: user.id,
    actorName: actorName(user),
    channel,
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

/**
 * The contract columns to stamp onto an activity-bearing source row at write
 * time, derived from whatever the ctx carries. All NULL when the ctx is empty
 * (an unthreaded / system write) — the t-1 columns are nullable by design and a
 * NULL channel is the sentinel t-3 turns into a visible defect.
 */
export function actorColumns(ctx: RequestCtx): {
  actorUserId: string | null;
  actorName: string | null;
  channel: RequestCtx["channel"] | null;
} {
  return {
    actorUserId: ctx.actorUserId ?? null,
    actorName: ctx.actorName ?? null,
    channel: ctx.channel ?? null,
  };
}

/**
 * Like {@link actorColumns}, but GUARANTEES a denormalised actor_name whenever an
 * actorUserId is present (ac-10): if the ctx didn't carry the name, resolve it
 * once at write time from `users`. This makes the service layer the single source
 * of truth for the denormalised snapshot — an entry point that supplies only
 * {actorUserId, channel} still produces a truthful, rename-proof actor_name, and
 * the name can never drift because it's frozen on the row at write.
 *
 * One indexed PK lookup on the write path only when the name wasn't pre-resolved;
 * the common authenticated entry points (REST, in-app agent) pass it for free.
 */
export async function resolveActorColumns(ctx: RequestCtx): Promise<{
  actorUserId: string | null;
  actorName: string | null;
  channel: RequestCtx["channel"] | null;
}> {
  const channel = ctx.channel ?? null;
  if (!ctx.actorUserId) {
    return { actorUserId: null, actorName: ctx.actorName ?? null, channel };
  }
  // Look the user up — this both fetches the denormalised name AND verifies the
  // actor_user_id FK is live. Attribution must NEVER break a write: an unknown or
  // stale actorUserId (the user was deleted, or a non-authenticated caller passed
  // a phantom id) degrades to unattributed rather than throwing a foreign-key
  // violation on every source-table insert.
  const u = await db.query.users.findFirst({
    where: eq(users.id, ctx.actorUserId),
    columns: { name: true, email: true },
  });
  if (!u) {
    return { actorUserId: null, actorName: ctx.actorName ?? null, channel };
  }
  return {
    actorUserId: ctx.actorUserId,
    actorName: ctx.actorName ?? actorName(u),
    channel,
  };
}
