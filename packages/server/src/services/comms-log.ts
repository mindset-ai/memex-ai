// Comms-log store (spec-6, memex-backstage — t-2).
//
// The fire-and-forget write path for the unified comms log: every outbound
// communication to a user — email (Postmark), in-app notification, dock/badge
// increment, OS push — records ONE row here at schedule or send time. core
// (memex-ai) owns + writes public.comms_log; Backstage READS it cross-tenant via
// the memex_admin BYPASSRLS role and never writes it (spec-6 dec-5 / spec-280).
//
// Like the usage-events / activity-log / visitors sinks, every write here is
// ADVISORY: a failed insert is logged and swallowed, NEVER thrown back into the
// originating send path. A logging fault must never block, delay, or fail a real
// communication (spec-6 ac-6 / ac-9). comms_log is RLS-excluded and carries no
// bus entity — the send paths that call this often run with no request ALS /
// tenant GUC (a background Activation send, a delivery webhook), so it must stay
// outside mutate() exactly like usage-events (allowlisted in mutate-coverage).
//
// METADATA ONLY (spec-6 dec-4): callers pass a one-line subject/summary — NEVER a
// message body. Full content stays in the system-of-record, reached via sourceRef.

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { commsLog, users, orgs } from "../db/schema.js";
import type { CommsLogRow } from "../db/schema.js";

/**
 * Retention window (spec-6 dec-4): comms_log keeps a bounded history; the source
 * system stays system-of-record for full content beyond it. Configurable via
 * COMMS_LOG_RETENTION_DAYS; defaults to 90 days.
 */
export const COMMS_LOG_RETENTION_DAYS = Number(process.env.COMMS_LOG_RETENTION_DAYS ?? 90);

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[comms-log]", ...args);
}

/** The channel a communication lands on (matches the comms_log CHECK). */
export type CommsChannel = "email" | "in_app" | "badge" | "os";

/** Lifecycle of a communication (matches the comms_log CHECK). */
export type CommsStatus = "scheduled" | "sent" | "delivered" | "failed";

export interface RecordCommInput {
  /** WHO the communication is addressed to (the single human). Required. */
  userId: string;
  /** WHICH channel it lands on. */
  channel: CommsChannel;
  /**
   * WHAT kind of comm — coarse intent ('transactional' | 'activation' |
   * 'work_notification' | …) plus any sub-type. Free text; the DB CHECK governs
   * channel/status, not type.
   */
  type: string;
  /**
   * Lifecycle. Defaults to 'sent' (an immediate-fire send). Pass 'scheduled'
   * with `scheduledFor` for a send planned ahead (spec-6 dec-3, t-4).
   */
  status?: CommsStatus;
  /** When the send is planned for. Set for scheduled sends; omit for immediate. */
  scheduledFor?: Date | null;
  /** When it actually went out. Omit while still scheduled. */
  sentAt?: Date | null;
  /** One-line subject/summary for the timeline — NEVER the full body (dec-4). */
  subject?: string | null;
  /** Pointer to the system-of-record row (Postmark message id, HubSpot send, …). */
  sourceRef?: string | null;
}

/**
 * Record one communication in the log. Advisory: any failure is logged and
 * swallowed so the originating send path is never affected (spec-6 ac-9 / ac-6).
 * Returns the inserted row (or null when skipped / failed) — handy for tests;
 * production callers ignore it.
 *
 * `userId` is required: a comm with no recipient is a defect, not a row — an
 * empty/missing userId is skipped (returns null) rather than inserting a
 * dangling row.
 */
export async function recordComm(
  input: RecordCommInput,
  conn: Db = db,
): Promise<CommsLogRow | null> {
  if (!input.userId) return null;
  try {
    const [row] = await conn
      .insert(commsLog)
      .values({
        userId: input.userId,
        channel: input.channel,
        type: input.type,
        status: input.status ?? "sent",
        scheduledFor: input.scheduledFor ?? null,
        sentAt: input.sentAt ?? null,
        subject: input.subject ?? null,
        sourceRef: input.sourceRef ?? null,
      })
      .returning();
    return row ?? null;
  } catch (err) {
    log("insert failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Delivery-status update (spec-6 t-3 / ac-8) ───────────────────────────────

/** The terminal/delivery outcomes a webhook applies to an already-recorded comm. */
export type CommsDeliveryStatus = Extract<CommsStatus, "sent" | "delivered" | "failed">;

/**
 * Apply a delivery outcome to the comms_log row identified by `sourceRef`
 * (e.g. a Postmark/Stripe delivery webhook flips sent → delivered or → failed).
 * Matches on `source_ref`; an UNMATCHED sourceRef is a graceful no-op (returns 0,
 * never errors) — a webhook can arrive for a comm we never logged. Advisory: any
 * failure is logged and swallowed so a webhook handler is never broken by it.
 * Returns the number of rows updated.
 */
export async function updateCommDeliveryStatus(
  sourceRef: string,
  status: CommsDeliveryStatus,
  conn: Db = db,
): Promise<number> {
  if (!sourceRef) return 0;
  try {
    const rows = await conn
      .update(commsLog)
      .set({ status })
      .where(eq(commsLog.sourceRef, sourceRef))
      .returning({ id: commsLog.id });
    return rows.length;
  } catch (err) {
    log("status update failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return 0;
  }
}

// ── Scheduled → sent transition (spec-6 t-4 / ac-11) ─────────────────────────

/**
 * Flip a previously-scheduled comm to 'sent' once it actually goes out: set
 * status='sent' and sent_at, matching by `source_ref` on a row that is still
 * unsent (sent_at IS NULL) so a duplicate dispatch can't rewrite an earlier
 * send time. Until this runs the row shows as scheduled in the timeline/schedule
 * (scheduled_for set, sent_at null) — that IS the "scheduled until sent" contract
 * (ac-11). Advisory: failures are logged and swallowed. Returns the updated row
 * (or null when nothing matched / on failure).
 */
export async function markCommSent(
  sourceRef: string,
  opts: { sentAt?: Date } = {},
  conn: Db = db,
): Promise<CommsLogRow | null> {
  if (!sourceRef) return null;
  try {
    const [row] = await conn
      .update(commsLog)
      .set({ status: "sent", sentAt: opts.sentAt ?? new Date() })
      .where(and(eq(commsLog.sourceRef, sourceRef), isNull(commsLog.sentAt)))
      .returning();
    return row ?? null;
  } catch (err) {
    log("mark-sent failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Retention prune (spec-6 t-8 / ac-15) ─────────────────────────────────────

/**
 * Delete comms_log rows older than the retention window (spec-6 dec-4). Runs
 * core-side, where the table is owned (Backstage never writes public.*). The
 * source system (Postmark / the app notification store) remains the
 * system-of-record for full content beyond the window. Unlike the advisory
 * write helpers this is a maintenance job, so a failure propagates (the operator
 * should know pruning didn't run). Returns the number of rows pruned.
 */
export async function pruneCommsLog(
  retentionDays: number = COMMS_LOG_RETENTION_DAYS,
  conn: Db = db,
): Promise<number> {
  const rows = await conn
    .delete(commsLog)
    .where(lt(commsLog.createdAt, sql`now() - (${retentionDays} * interval '1 day')`))
    .returning({ id: commsLog.id });
  return rows.length;
}

// ── Retention prune scheduler (spec-341 t-3 / dec-2) ─────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start the periodic comms_log retention prune. Mirrors startActivityLogSweep
 * (services/activity-log-sweep.ts): an in-process daily interval that calls
 * pruneCommsLog. Booted from index.ts at server start; caller `.unref()`s the
 * timer so it never holds the process open. A ~90-day window needs no finer
 * cadence; a failed pass just retries next day.
 */
export function startCommsLogPrune(intervalMs: number = ONE_DAY_MS): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const deleted = await pruneCommsLog();
      if (deleted > 0) {
        // eslint-disable-next-line no-console
        console.log(`[comms-log-prune] deleted ${deleted} row(s) past retention`);
      }
    } catch (err) {
      log("prune failed (will retry next tick):", err instanceof Error ? err.message : err);
    }
  }, intervalMs);
}

// ── Email recording at the send chokepoint (spec-341 t-1 / dec-4 → B) ────────

/**
 * Record an email send in the comms log (spec-341). Called fire-and-forget from
 * the email chokepoint (services/email/sender.ts). Resolves the recipient to a
 * user: the passed `userId` if the caller threaded it, else an email→public.users
 * lookup. If no user resolves — a waitlist / pre-signup / stranger-invite address —
 * it SKIPS (the comms log is a per-signed-up-user timeline; dec-4 → B). `commsType`
 * labels the email (defaults to 'transactional'); `messageId` is the Postmark
 * MessageID stored as source_ref so the delivery webhook can match it later.
 * Advisory: any failure is logged and swallowed — never affects the send.
 */
export async function recordEmailComm(
  input: { to: string; userId?: string; commsType?: string; subject?: string; messageId?: string },
  conn: Db = db,
): Promise<CommsLogRow | null> {
  try {
    let userId = input.userId;
    if (!userId) {
      const [u] = await conn
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.to))
        .limit(1);
      userId = u?.id;
    }
    if (!userId) return null; // non-user recipient — not a per-user comm
    return await recordComm(
      {
        userId,
        channel: "email",
        type: input.commsType ?? "transactional",
        subject: input.subject ?? null,
        sourceRef: input.messageId ?? null,
      },
      conn,
    );
  } catch (err) {
    log("recordEmailComm failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Stripe-sent emails (spec-341 t-4 / dec-3) ────────────────────────────────

/**
 * Record an email that STRIPE sent directly (not via our Postmark) — receipts on
 * payment success, dunning on failure (spec-341 dec-3). Called from the Stripe
 * webhook handlers (routes/stripe-webhook.ts). Resolves the Stripe customer → the
 * org's billing-contact email → a user, then records via recordEmailComm with a
 * `stripe:`-prefixed source_ref so the row is identifiable as Stripe-sourced.
 *
 * BEST-EFFORT (dec-3): we infer the email from the billing event — Stripe sends no
 * literal 'email sent' webhook, and there is no delivery status. Skips (returns
 * null) when no billing contact / user resolves. Advisory: never throws.
 */
export async function recordStripeEmailComm(
  input: { customerId: string; commsType?: string; subject?: string; sourceRef?: string },
  conn: Db = db,
): Promise<CommsLogRow | null> {
  try {
    if (!input.customerId) return null;
    const [org] = await conn
      .select({ email: orgs.billingContactEmail })
      .from(orgs)
      .where(eq(orgs.stripeCustomerId, input.customerId))
      .limit(1);
    const to = org?.email;
    if (!to) return null; // no billing contact on file → skip (best-effort)
    return await recordEmailComm(
      {
        to,
        commsType: input.commsType ?? "transactional",
        subject: input.subject,
        messageId: input.sourceRef ?? `stripe:${input.customerId}`,
      },
      conn,
    );
  } catch (err) {
    log("recordStripeEmailComm failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}
