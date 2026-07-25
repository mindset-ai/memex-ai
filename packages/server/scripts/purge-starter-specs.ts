// One-shot starter-Spec purge runner (spec-509 dec-1 / ac-11 / ac-12).
//
// Deletes every PRISTINE seeded "Understanding Memex" Spec across all personal Memexes.
// A copy anyone ever opened, commented on, edited, versioned, or archived is SPARED and
// reported with the signal that spared it. Idempotent — a second run deletes 0.
//
// Operator-run, one-time, per environment. Needs DATABASE_URL in the environment.
//
// ALWAYS dry-run first: the deletion is irreversible (the doc and its sections,
// decisions, and ACs all cascade; the only remedy is a Cloud SQL point-in-time restore).
// Read the spared table before you type the live command, and capture the live output —
// once the rows are gone, that log is the only record of what was deleted.
//
// Usage:
//   pnpm --filter @memex/server db:purge-starter-specs --dry-run   # report only
//   pnpm --filter @memex/server db:purge-starter-specs             # LIVE

import { purgeStarterSpecs } from "../src/services/starter-spec-purge.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const label = dryRun ? "starter-spec purge (DRY-RUN — no writes)" : "starter-spec purge (LIVE)";

  console.log(`[${label}] starting…`);
  const { docsDeleted, docsSpared, memexesVisited, perMemex } = await purgeStarterSpecs({
    dryRun,
  });

  // Only memexes that hold a seeded copy are interesting; a memex that never had one is
  // noise in a 200-row table.
  const interesting = perMemex.filter((m) => m.found > 0);
  if (interesting.length > 0) {
    console.log(`\n[${label}] per-memex:`);
    console.log("  memexId                               found  deleted  spared");
    console.log("  ------------------------------------  -----  -------  ------");
    for (const m of interesting) {
      console.log(
        `  ${m.memexId}  ${String(m.found).padStart(5)}  ${String(m.deleted).padStart(7)}  ${String(m.spared.length).padStart(6)}`,
      );
    }
  }

  // Every spared copy, with its reason. This is the audit trail for the residue the
  // broad predicate deliberately leaves behind (dec-1) — print it even in a live run.
  const allSpared = perMemex.flatMap((m) => m.spared.map((s) => ({ ...s, memexId: m.memexId })));
  if (allSpared.length > 0) {
    console.log(`\n[${label}] SPARED (${allSpared.length}) — engagement signal present:`);
    for (const s of allSpared) {
      console.log(`  ${s.memexId}  ${s.handle}  ← ${s.reason}`);
    }
  }

  console.log(`\n[${label}] totals across ${memexesVisited} personal memex(es):`);
  console.log(`  ${dryRun ? "docsToDelete" : "docsDeleted"}: ${docsDeleted}`);
  console.log(`  docsSpared:   ${docsSpared}`);

  if (docsSpared === 0 && docsDeleted > 0) {
    console.log(
      "\n  ⚠ zero spared. At least a few copies are known to carry engagement signals —" +
        "\n    a spared count of 0 suggests the pristine predicate is not matching. Investigate" +
        "\n    before running live.",
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[starter-spec purge] failed:", err);
  process.exit(1);
});
