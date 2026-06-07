// Backfill the default Standards into EXISTING personal Memexes (spec-184 t-4 / dec-4).
//
// New signups get the six portable best-practice Standards automatically via the
// post-commit hook in ensureUserNamespace. THIS script is the one-time catch-up for
// personal Memexes that were created BEFORE the feature shipped — it seeds every
// personal namespace (namespaces.kind='user') whose Standards list is still EMPTY.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-default-standards.ts
//
// Idempotent + non-destructive: seedDefaultStandards() no-ops on any Memex that
// already has a standard (the zero-Standards guard), so re-running (e.g. on every
// deploy) does zero work once seeded and NEVER overwrites a user-authored Standard or
// intrudes on a Memex a user has started curating (dec-4 empty-list scope). It only
// INSERTs into personal Memexes — never team/org Memexes (dec-6).
//
// CI/CD wiring (dec-4, "wired into the deploy, never run by hand"): the deploy step in
// packages/server/deploy.sh runs this AFTER migrations, bounded by `timeout` and
// non-gating (|| echo), so a backfill hiccup can never fail a live deploy.

import { backfillDefaultStandards } from "../src/services/default-standards.js";

async function main(): Promise<void> {
  console.log(
    "[default-standards-backfill] starting — seeding existing personal Memexes with an empty Standards list…",
  );
  const { memexesSeeded } = await backfillDefaultStandards();
  console.log(
    `[default-standards-backfill] done — seeded ${memexesSeeded} personal Memex(es); Memexes that already had Standards were skipped.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[default-standards-backfill] failed:", err);
  process.exit(1);
});
