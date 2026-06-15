// One-off backfill of Mixpanel user PROFILES (spec-297 dec-7 / ac-25).
//
// Sets email_domain (domain only) + org link(s) on the Mixpanel People profile for
// EVERY existing user via /engage, so the Users tab is complete from day one — not
// only for users active after the profile slice shipped.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-mixpanel-profiles.ts
//
// Prereqs: same env as the server. MIXPANEL_TOKEN must be set (the same per-env
// secret the forwarder uses) — without it this is a no-op (self-hosted instances
// never forward; dec-5). Idempotent ($engage $set is an upsert), so safe to re-run.
//
// Why a script (not a route): backfill is operator-grade and touches every user, so
// we want it triggered explicitly from a dev/prod shell, not a button click.

import { backfillAllUserProfiles } from "../src/services/mixpanel-profile.js";

async function main(): Promise<void> {
  const { total, sent } = await backfillAllUserProfiles();
  if (total === 0 && sent === 0) {
    // eslint-disable-next-line no-console
    console.log(
      "[backfill-mixpanel-profiles] no MIXPANEL_TOKEN configured (or no users) — nothing forwarded.",
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`[backfill-mixpanel-profiles] set profiles for ${sent}/${total} user(s) via /engage.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[backfill-mixpanel-profiles] failed:", err);
    process.exit(1);
  });
