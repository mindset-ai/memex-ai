// spec-453 t-2 (dec-1 / dec-9) — fire the "See it verified" milestone email.
//
// Called FIRE-AND-FORGET from the test-events ingest path on a `verified` (pass)
// emission (routes/test-events.ts), never awaited in the request or its transaction —
// that endpoint is a CI hot path. Advisory + idempotent: it can never break or delay
// ingestion, and it emails a given user at most once, ever.

import { and, eq, isNull, sql } from "drizzle-orm";
import { type Db, db } from "../../db/connection.js";
import { users } from "../../db/schema.js";
import { activationEmailsEnabled } from "./activation-flag.js";
import { hasComm } from "../comms-log.js";
import { sendLifecycleEmail } from "./lifecycle-send.js";
import { buildVerifiedMilestoneEmail } from "./templates.js";

const COMMS_KEY = "activation.verified_milestone";

function appBaseUrl(): string {
  // Generic Specs board (dec-2) — the same base the other lifecycle CTAs use.
  return process.env.APP_BASE_URL ?? "https://memex.ai";
}

function firstName(name: string | null): string | undefined {
  return name?.trim().split(/\s+/)[0] || undefined;
}

/**
 * Attribute a first-ever AC verification to `userId` and, if it is genuinely their
 * first, send the "See it verified" email exactly once.
 *
 *  - Attribution (dec-9): `userId` is the owner of the emission key that authorised
 *    the `verified` write (`emissionKey.createdByUserId`), resolved by the caller.
 *    A null userId (a CI key with no owner, or a legacy key) is a NO-OP — never guess,
 *    never send. The free-form `test_events.actor` is deliberately NOT used.
 *  - Flag FIRST (dec-1): while ACTIVATION_EMAILS_ENABLED is off we do NOT stamp — a
 *    flag-off period must never silently burn a user's one-time milestone.
 *  - Atomic first-ever gate: `UPDATE ... WHERE first_ac_verified_at IS NULL`. Only the
 *    first caller flips NULL→now(); a second verified AC, a parallel-CI race, or a
 *    pre-existing account backfilled at go-live (dec-10) updates 0 rows → no send.
 *  - Send via the lifecycle chokepoint (dec-5): suppression + stream + List-Unsubscribe
 *    + team identity live there. A suppressed user's milestone is consumed (acceptable —
 *    they unsubscribed). Dedup on the stable comms key is belt-and-suspenders (dec-6);
 *    the column is the primary gate.
 *  - Advisory: every failure is swallowed so ingestion is never affected.
 */
export async function fireVerifiedMilestoneForUser(
  userId: string | null | undefined,
  conn: Db = db,
): Promise<void> {
  try {
    if (!userId) return;
    // Flag FIRST — never stamp while the sequence is off (dec-1).
    if (!activationEmailsEnabled()) return;

    // Atomic first-ever gate (dec-9): the sole writer of the NULL→now() transition.
    const stamped = await conn
      .update(users)
      .set({ firstAcVerifiedAt: sql`now()` })
      .where(and(eq(users.id, userId), isNull(users.firstAcVerifiedAt)))
      .returning({ id: users.id });
    if (stamped.length === 0) return; // not first-ever (or race lost / pre-existing)

    const [u] = await conn
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    if (!u?.email) return;

    if (await hasComm(u.id, COMMS_KEY, conn)) return;

    const message = buildVerifiedMilestoneEmail({
      to: u.email,
      firstName: firstName(u.name),
      appUrl: appBaseUrl(),
    });
    await sendLifecycleEmail({ id: u.id, email: u.email }, message);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[verified-milestone-send] failed (swallowed):",
      err instanceof Error ? err.message : err,
    );
  }
}
