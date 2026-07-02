// spec-427 t-8 — the one-time backlog batch (dec-3). A SEPARATE entry point from the
// daily drip (t-7) that catches up the signups who stalled BEFORE the automation went
// live (~97 at go-live). Eligible = users who signed up (users.created_at) before the
// go-live cutoff AND are still in a matching stalled cohort at send time.
//
// It REUSES t-7's per-user send + ladder by delegating to runActivationDrip with an
// injected candidate set, so dedup, cohort exclusivity, dwell timers, the
// ACTIVATION_EMAILS_ENABLED gate, per-user error isolation and stable keying are all
// identical. That shared dedup is exactly why switching the evergreen drip on afterwards
// never re-sends to anyone the backlog already emailed (ac-5/ac-9): both read and skip
// on the same stable comms_log key.

import { and, isNotNull, lt } from "drizzle-orm";
import { type Db, db } from "../../db/connection.js";
import { users } from "../../db/schema.js";
import { runActivationDrip, type CandidateUser, type DripSummary } from "./activation-drip.js";

// The backlog candidate set: verified signups with an email whose account predates the
// go-live cutoff (ac-9). The "still stalled at send time" half of eligibility is applied
// per-user downstream by evaluateActivationState inside runActivationDrip — an
// already-activated backlog user resolves to no cohort and sends nothing.
export async function selectBacklogCandidates(goLiveAt: Date, conn: Db = db): Promise<CandidateUser[]> {
  return conn
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(and(isNotNull(users.email), isNotNull(users.emailVerifiedAt), lt(users.createdAt, goLiveAt)));
}

// Run the one-time backlog. Delegates to runActivationDrip with the backlog candidate
// set, inheriting the flag gate (ac-16), per-user isolation, the dwell/ladder, and the
// comms_log dedup that makes the hand-off to the evergreen drip idempotent (ac-5/ac-9).
// `goLiveAt` defaults to now: everyone who signed up before this run is backlog; anyone
// after is the daily drip's job (picked up with its normal dwell).
export async function runActivationBacklog(
  goLiveAt: Date = new Date(),
  now: Date = new Date(),
  conn: Db = db,
): Promise<DripSummary> {
  const candidates = await selectBacklogCandidates(goLiveAt, conn);
  return runActivationDrip(now, conn, candidates);
}
