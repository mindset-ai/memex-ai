// One-off backlog send for the spec-427 activation drip (t-8 / dec-3).
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/activation-backlog.ts
//   ACTIVATION_BACKLOG_CUTOFF=2026-07-01T00:00:00Z pnpm --filter @memex/server tsx scripts/activation-backlog.ts
//
// Sends the correct single activation email to each signup who stalled BEFORE the
// automation went live (default cutoff: now — everyone existing at run time). REUSES the
// daily drip's per-user send, so the ACTIVATION_EMAILS_ENABLED gate + comms_log dedup
// apply: it sends NOTHING unless the flag is on (prod-only, by hand), it is idempotent
// (re-running skips anyone already emailed), and switching the evergreen drip on
// afterwards never double-sends.
//
// Why a script (not a route): the backlog is operator-grade and touches every existing
// user, so we trigger it explicitly from a prod shell, not a button click.
import "dotenv/config";
import { runActivationBacklog } from "../src/services/email/activation-backlog.js";

async function main(): Promise<void> {
  const raw = process.env.ACTIVATION_BACKLOG_CUTOFF;
  const goLiveAt = raw ? new Date(raw) : new Date();
  if (Number.isNaN(goLiveAt.getTime())) {
    throw new Error(`ACTIVATION_BACKLOG_CUTOFF is not a valid date: "${raw}"`);
  }
  // eslint-disable-next-line no-console
  console.log(`[activation-backlog] cutoff=${goLiveAt.toISOString()} — sending to stalled signups before this…`);
  const s = await runActivationBacklog(goLiveAt);
  // eslint-disable-next-line no-console
  console.log(
    `[activation-backlog] evaluated ${s.evaluated}, sent ${s.sent} (E1=${s.byCohort.connected_inactive} E2=${s.byCohort.signed_in_dormant}), errors ${s.errors}.`,
  );
  if (s.evaluated === 0) {
    // eslint-disable-next-line no-console
    console.log("[activation-backlog] nothing evaluated — is ACTIVATION_EMAILS_ENABLED on? (default OFF, prod-only)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[activation-backlog] failed:", err);
    process.exit(1);
  });
