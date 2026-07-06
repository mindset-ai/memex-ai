// spec-453 t-5 — the "Connect with people" Day-12 standalone pass (dec-7).
//
// A SEPARATE entry point from the cohort drip (spec-427 t-7): it sends the unconditional
// Day-12-since-signup check-in to every verified signup, INDEPENDENT of the
// connected-inactive / signed-in-dormant ladder. A user can receive both a spec-427
// cohort email AND this one in a single tick (ac-17) — this pass neither consumes nor is
// blocked by runActivationDrip's "at most one email per run" cap, and is NOT a rung on
// that ladder.
//
// Reuse, don't rebuild: the verified-signup candidate set (selectActivationCandidates,
// spec-427 t-7), the SOLE lifecycle chokepoint (sendLifecycleEmail — suppression,
// broadcast stream, RFC 8058 List-Unsubscribe, team From/Reply-To, and the
// ACTIVATION_EMAILS_ENABLED gate), the comms_log dedup (hasComm on a stable key), and
// the builder (buildConnectPeopleEmail, t-4). The only genuinely new logic is the Day-12
// window plus the go-live back-catalog floor.
//
// TRIGGER: none here. This pass wires NO setInterval and touches NO index.ts — its sole
// trigger is the shared Cloud Scheduler → authenticated HTTP endpoint (t-6, dec-11).
// Both `goLiveAt` and `now` are injected so the whole pass is deterministic and
// unit-testable.
//
// IDEMPOTENCY: the eligible window [goLiveAt−12d, now−12d] only GROWS — a past-Day-12
// user stays a candidate on every future pass — so "at most once per user" is carried by
// the hasComm dedup, NOT the window (and a missed scheduler day self-heals on the next).
// Connect has no atomic once-ever gate like "See it verified"'s first_ac_verified_at; its
// once-only property leans entirely on hasComm + t-6's single-invocation guarantee
// (dec-11). A suppressed user is re-evaluated every pass — harmless, since
// sendLifecycleEmail writes no comms_log row when it skips a suppressed recipient.

import { db, type Db } from "../../db/connection.js";
import { hasComm } from "../comms-log.js";
import { activationEmailsEnabled } from "./activation-flag.js";
import { sendLifecycleEmail } from "./lifecycle-send.js";
import { selectActivationCandidates } from "./activation-drip.js";
import { buildConnectPeopleEmail } from "./templates.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Day-12-since-signup (overview / dec-7). Unlike "See it verified" (milestone-gated), the
// source doc's "Day 12" is a literal calendar offset here.
export const CONNECT_PEOPLE_DWELL_DAYS = 12;

// Stable comms_log key (dec-6). Dedup counts THIS, never the mutable subject line. Kept
// in sync with the `commsType` buildConnectPeopleEmail stamps on the message it returns.
export const CONNECT_PEOPLE_COMMS_KEY = "activation.connect_people";

function firstName(name: string | null): string | undefined {
  return name?.trim().split(/\s+/)[0] || undefined;
}

/**
 * Is this signup eligible for "Connect with people" as of `now`? Pure. Two gates:
 *  1. Day-12 reached — at least 12 days elapsed since signup (`createdAt`).
 *  2. Not back-catalog (dec-10 / ac-19) — the user CROSSED Day-12 at or after go-live,
 *     i.e. `createdAt >= goLiveAt − 12d`. Anyone whose Day-12 fell before go-live is a
 *     pre-existing account and is excluded, so the first post-go-live pass never blasts
 *     the >12-day base.
 *
 * `goLiveAt` is a FIXED go-live instant, NEVER per-run now() (see runConnectPeoplePass).
 */
export function connectPeopleEligible(createdAt: Date, now: Date, goLiveAt: Date): boolean {
  const window = CONNECT_PEOPLE_DWELL_DAYS * ONE_DAY_MS;
  const reachedDay12 = now.getTime() - createdAt.getTime() >= window;
  const crossedAtOrAfterGoLive = createdAt.getTime() >= goLiveAt.getTime() - window;
  return reachedDay12 && crossedAtOrAfterGoLive;
}

export interface ConnectPassSummary {
  /** Candidates inside the Day-12 window on which a send decision was run. */
  evaluated: number;
  sent: number;
  errors: number;
}

/**
 * One "Connect with people" daily pass.
 *
 * `goLiveAt` is REQUIRED and must be a FIXED go-live instant — the same deploy-time
 * moment t-1's migration backfilled `users.first_ac_verified_at` to (dec-10), so the two
 * emails agree on when go-live was. NEVER pass per-run now(): that would collapse the
 * back-catalog floor to an empty window and the pass would send to ~nobody, silently.
 * Ordered `(goLiveAt, now, conn)` to mirror runActivationBacklog.
 *
 * Flag-gated up front (ac-16 / ACTIVATION_EMAILS_ENABLED) so an OFF pass does no scan and
 * no work; the chokepoint re-checks, belt-and-suspenders. Each user is isolated in its
 * own try/catch: one failed send never aborts the run for everyone downstream. This is
 * NOT a rung on runActivationDrip — deliberately independent (ac-17).
 */
export async function runConnectPeoplePass(
  goLiveAt: Date,
  now: Date = new Date(),
  conn: Db = db,
): Promise<ConnectPassSummary> {
  const summary: ConnectPassSummary = { evaluated: 0, sent: 0, errors: 0 };
  if (!activationEmailsEnabled()) return summary;

  const candidates = await selectActivationCandidates(conn);
  for (const user of candidates) {
    if (!user.createdAt || !connectPeopleEligible(user.createdAt, now, goLiveAt)) continue;
    summary.evaluated++;
    try {
      if (!user.email) continue;
      // Dedup on the stable key ONLY (ac-7) — never blocked by a spec-427 cohort send,
      // which carries a different key (ac-17 independence).
      if (await hasComm(user.id, CONNECT_PEOPLE_COMMS_KEY, conn)) continue;
      const message = buildConnectPeopleEmail({ to: user.email, firstName: firstName(user.name) });
      const ok = await sendLifecycleEmail({ id: user.id, email: user.email }, message);
      if (ok) summary.sent++;
    } catch (err) {
      summary.errors++;
      // eslint-disable-next-line no-console
      console.error(
        `[connect-people] send failed for user ${user.id} (skipped, run continues):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return summary;
}
