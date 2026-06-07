// Backfill the Handhold onboarding demo into EXISTING personal Memexes (spec-178 t-5 / dec-7).
//
// New signups get the five frozen ⌘K-search demo specs automatically via the
// post-commit hook in ensureUserNamespace. THIS script is the one-time catch-up
// for personal Memexes that were created BEFORE the feature shipped — it seeds
// every personal namespace (namespaces.kind='user') that doesn't already have them.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-handhold-demo.ts
//
// Idempotent + non-destructive: seedHandholdDemo() no-ops on any Memex that already
// has is_demo specs, so re-running (e.g. on every deploy) does zero work once seeded.
// It only INSERTs demo content — it never touches real specs or team Memexes.
//
// CI/CD wiring (dec-7, "wired into the deploy, never run by hand"): the deploy owner
// adds this AFTER migrations in the deploy step, best-effort / non-gating so a backfill
// hiccup never fails a live deploy:
//   pnpm --filter @memex/server tsx scripts/backfill-handhold-demo.ts || true

import { backfillHandholdDemo } from "../src/services/handhold-demo.js";

async function main(): Promise<void> {
  console.log("[handhold-backfill] starting — seeding existing personal Memexes that lack the demo…");
  const { memexesSeeded } = await backfillHandholdDemo();
  console.log(
    `[handhold-backfill] done — seeded ${memexesSeeded} personal Memex(es); already-seeded ones were skipped.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[handhold-backfill] failed:", err);
  process.exit(1);
});
