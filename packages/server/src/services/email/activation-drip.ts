// spec-427 t-7 — the daily activation drip evaluator (Slice B, the core orchestration).
//
// For each candidate user it evaluates the CURRENT cohort state (t-5) at send time and
// sends AT MOST ONE email per run via a priority ladder — Email 1 (connected-inactive,
// hard MCP-connected gate) → else Email 2 (signed-in-dormant) → else nothing. The
// ladder is structural: evaluateActivationState returns at most one mutually-exclusive
// cohort, so "never both in a run" (ac-3) falls out of the state model, not a flag.
//
// Every send goes through the SOLE lifecycle chokepoint sendLifecycleEmail (t-4), which
// owns the ACTIVATION_EMAILS_ENABLED gate (ac-16), suppression (ac-12), the broadcast
// stream + List-Unsubscribe (ac-11), and the team From/Reply-To (dec-1/ac-7). The
// chokepoint records each send in comms_log under the message's stable `commsType`
// (dec-7); this drip only READS that log for dedup — it never writes it. Dedup and the
// two-per-cohort ceiling are therefore keyed on the stable template key, never the
// mutable subject line (ac-14).

import { and, eq, isNotNull } from "drizzle-orm";
import { type Db, db } from "../../db/connection.js";
import { users, namespaces, memexes } from "../../db/schema.js";
import { evaluateActivationState, type ActivationCohort } from "../activation-cohort.js";
import { hasComm } from "../comms-log.js";
import { activationEmailsEnabled } from "./activation-flag.js";
import { sendLifecycleEmail } from "./lifecycle-send.js";
import { buildConnectedInactiveEmail, buildSignedInDormantEmail } from "./templates.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Dwell timers (overview / t-7): Email 1 fires after ~2 days in connected-inactive,
// Email 2 after ~3 days in signed-in-dormant. Erring short is cheap at this volume.
export const ACTIVATION_DWELL_DAYS: Record<ActivationCohort, number> = {
  connected_inactive: 2,
  signed_in_dormant: 3,
};

// Stable comms_log keys (dec-7 / ac-14). Dedup + sequencing key on THESE, never the
// mutable subject line. Kept in sync with the `commsType` the Slice A builders stamp
// onto the returned message.
export const ACTIVATION_COMMS_KEY: Record<ActivationCohort, string> = {
  connected_inactive: "activation.connected_inactive",
  signed_in_dormant: "activation.signed_in_dormant",
};

// The hard ceiling per cohort key (overview: "hard-cap two emails per cohort"),
// reserved for a future ~5-day fast-follow reminder. v1 sends EXACTLY ONE email per
// cohort — enforced by the hasComm dedup below — so this ceiling is not a live branch
// today; when the fast-follow lands, the dedup becomes a dwell-gated count against this
// cap (still counting the stable key, never the subject).
export const ACTIVATION_PER_COHORT_CAP = 2;

function appBaseUrl(): string {
  // Mirrors welcome-send.ts: int → int.memex.ai, prod → memex.ai (dec-8).
  return process.env.APP_BASE_URL ?? "https://memex.ai";
}

function firstName(name: string | null): string | undefined {
  return name?.trim().split(/\s+/)[0] || undefined;
}

/** Has the dwell timer elapsed for this cohort as of `now`? Pure. */
export function dwellElapsed(cohort: ActivationCohort, enteredAt: Date, now: Date): boolean {
  return now.getTime() - enteredAt.getTime() >= ACTIVATION_DWELL_DAYS[cohort] * ONE_DAY_MS;
}

export interface CandidateUser {
  id: string;
  email: string | null;
  name: string | null;
  // spec-453 t-5: signup time, needed by the "Connect with people" Day-12 pass
  // (connect-people.ts). Optional so the drip/backlog and their tests, which don't
  // read it, are unaffected — selectActivationCandidates always populates it.
  createdAt?: Date;
}

export type DripReason =
  | "sent"
  | "no_cohort"
  | "dwell_pending"
  | "already_sent"
  | "no_email"
  | "suppressed_or_off"
  | "error";

export interface DripOutcome {
  userId: string;
  cohort: ActivationCohort | null;
  sent: boolean;
  reason: DripReason;
}

export interface DripSummary {
  evaluated: number;
  sent: number;
  byCohort: Record<ActivationCohort, number>;
  errors: number;
}

// Resolve the user's personal Memex path segment (`<namespace>/<memex>`). The personal
// namespace is the one this user OWNS (namespaces.owner_user_id) — the same anchor
// listAccessibleNamespaces uses; its memex slug is the literal "personal" in v1.
// Returns null when none resolves, so the caller can fall back to the app root rather
// than mint a broken deep-link.
async function personalMemexPath(userId: string, conn: Db): Promise<string | null> {
  const [row] = await conn
    .select({ ns: namespaces.slug, mx: memexes.slug })
    .from(namespaces)
    .innerJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(eq(namespaces.ownerUserId, userId))
    .limit(1);
  return row ? `${row.ns}/${row.mx}` : null;
}

async function buildActivationMessage(
  cohort: ActivationCohort,
  user: CandidateUser & { email: string },
  conn: Db,
) {
  const base = appBaseUrl();
  const name = firstName(user.name);
  if (cohort === "signed_in_dormant") {
    // Email 2 CTA "Open Memex AI" → the app root (Q1: unambiguous either way).
    return buildSignedInDormantEmail({ to: user.email, firstName: name, appUrl: base });
  }
  // Email 1 CTA "Create a spec" → the new-spec modal deep-link (Q1: SpecList's ?new=1),
  // with "your Memex" pointing at the same board. Fall back to the app root if we can't
  // resolve a personal path (rare — every user has one, but never send a broken link).
  const path = await personalMemexPath(user.id, conn);
  const memexUrl = path ? `${base}/${path}/specs` : base;
  const createSpecUrl = path ? `${base}/${path}/specs?new=1` : base;
  return buildConnectedInactiveEmail({ to: user.email, firstName: name, createSpecUrl, memexUrl });
}

// Evaluate + send at most one activation email for one user. Pure orchestration on top
// of the t-5 cohort primitive, the dwell timers, the comms_log dedup, and the t-4
// chokepoint. Never throws for a routine skip; a transport failure propagates to the
// batch loop, which isolates it per-user.
export async function sendActivationEmailForUser(
  user: CandidateUser,
  now: Date = new Date(),
  conn: Db = db,
): Promise<DripOutcome> {
  const base = { userId: user.id };
  if (!user.email) return { ...base, cohort: null, sent: false, reason: "no_email" };

  const { cohort, enteredAt } = await evaluateActivationState(user.id, conn);
  if (!cohort || !enteredAt) return { ...base, cohort: null, sent: false, reason: "no_cohort" };

  if (!dwellElapsed(cohort, enteredAt, now)) {
    return { ...base, cohort, sent: false, reason: "dwell_pending" };
  }

  // Dedup (ac-1/ac-3/ac-14): v1 sends exactly one email per cohort, keyed on the stable
  // comms_log template key — never the subject. State is re-evaluated live, so a user
  // who already carries the OTHER cohort's key rolls into this cohort and still sends
  // (ac-4): we only check the key for the cohort we're about to send.
  if (await hasComm(user.id, ACTIVATION_COMMS_KEY[cohort], conn)) {
    return { ...base, cohort, sent: false, reason: "already_sent" };
  }

  const message = await buildActivationMessage(cohort, { ...user, email: user.email }, conn);
  const ok = await sendLifecycleEmail({ id: user.id, email: user.email }, message);
  return { ...base, cohort, sent: ok, reason: ok ? "sent" : "suppressed_or_off" };
}

// The candidate set: verified signups with an email. Both cohorts require a verified
// user (Email 1 → MCP connected implies signed-in; Email 2 → email_verified_at), so
// this pre-filter is safe and keeps the per-user work bounded. At current volume
// (~100 users, ~6 sends/day) a full scan is fine — see the scaling follow-up issue.
export async function selectActivationCandidates(conn: Db = db): Promise<CandidateUser[]> {
  return conn
    .select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt })
    .from(users)
    .where(and(isNotNull(users.email), isNotNull(users.emailVerifiedAt)));
}

// One daily pass. Flag-gated up front (ac-16) so an OFF drip does no scan and no work;
// the chokepoint also guards, belt-and-suspenders. Each user is isolated in its own
// try/catch: a single failed send (e.g. a Postmark non-2xx that sendLifecycleEmail
// re-throws) must never abort the day's run for everyone downstream. `candidates` can
// be injected (tests, and t-8's backlog batch, which reuses this per-user send + ladder
// so the same exclusivity / dedup / keying applies).
export async function runActivationDrip(
  now: Date = new Date(),
  conn: Db = db,
  candidates?: CandidateUser[],
): Promise<DripSummary> {
  const summary: DripSummary = {
    evaluated: 0,
    sent: 0,
    byCohort: { connected_inactive: 0, signed_in_dormant: 0 },
    errors: 0,
  };
  if (!activationEmailsEnabled()) return summary;

  const set = candidates ?? (await selectActivationCandidates(conn));
  for (const user of set) {
    summary.evaluated++;
    try {
      const outcome = await sendActivationEmailForUser(user, now, conn);
      if (outcome.sent && outcome.cohort) {
        summary.sent++;
        summary.byCohort[outcome.cohort]++;
      }
    } catch (err) {
      summary.errors++;
      // eslint-disable-next-line no-console
      console.error(
        `[activation-drip] send failed for user ${user.id} (skipped, run continues):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return summary;
}

/**
 * Start the daily activation drip. Mirrors startCommsLogPrune / startActivityLogSweep:
 * an in-process daily interval, `.unref()`'d by the caller in index.ts so it never holds
 * the process open. A failed pass just retries next day; low volume needs no finer
 * cadence. The whole pass is a no-op while ACTIVATION_EMAILS_ENABLED is off.
 */
export function startActivationDrip(intervalMs: number = ONE_DAY_MS): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const s = await runActivationDrip();
      if (s.sent > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[activation-drip] sent ${s.sent} (E1=${s.byCohort.connected_inactive} E2=${s.byCohort.signed_in_dormant}) of ${s.evaluated} evaluated`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[activation-drip] run failed (will retry next tick):", err instanceof Error ? err.message : err);
    }
  }, intervalMs);
}
