// One-shot demo→starter sweep runner (spec-474 dec-3 / ac-15 / ac-16 / ac-17).
//
// Deletes every is_demo doc across all personal Memexes and seeds the "Understanding
// Memex" starter Spec into any personal Memex whose owner has not authored their own
// real spec. Idempotent — safe to re-run; a second run deletes 0 / seeds 0.
//
// Local/deploy operator-run, one-time. Needs DATABASE_URL in the environment.
//
// Usage:
//   pnpm --filter @memex/server db:sweep-demo-to-starter            # LIVE
//   pnpm --filter @memex/server db:sweep-demo-to-starter --dry-run  # report only

import { sweepDemoToStarter } from "../src/services/demo-to-starter-sweep.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const label = dryRun ? "demo→starter sweep (DRY-RUN — no writes)" : "demo→starter sweep (LIVE)";

  console.log(`[${label}] starting…`);
  const { demoDocsDeleted, memexesSeeded, memexesSkipped, perMemex } =
    await sweepDemoToStarter({ dryRun });

  // Per-memex breakdown table. Only rows that DO something (demo docs present or a
  // starter seeded) are printed — a pristine already-starter'd memex is uninteresting.
  const interesting = perMemex.filter((m) => m.demoDocs > 0 || m.seeded);
  if (interesting.length > 0) {
    console.log(`\n[${label}] per-memex changes:`);
    console.log("  memexId                               demoDocs  ownSpec  seededStarter");
    console.log("  ------------------------------------  --------  -------  -------------");
    for (const m of interesting) {
      console.log(
        `  ${m.memexId}  ${String(m.demoDocs).padStart(8)}  ${String(m.hadOwnSpec).padStart(7)}  ${String(m.seeded).padStart(13)}`,
      );
    }
  } else {
    console.log(`\n[${label}] nothing to change — every personal memex is already reconciled.`);
  }

  console.log(`\n[${label}] totals across ${perMemex.length} personal memex(es):`);
  if (dryRun) {
    console.log(`  demoDocsToDelete: ${demoDocsDeleted}`);
    console.log(`  memexesToSeed:    ${memexesSeeded}`);
    console.log(`  memexesToSkip:    ${memexesSkipped}`);
  } else {
    console.log(`  demoDocsDeleted:  ${demoDocsDeleted}`);
    console.log(`  memexesSeeded:    ${memexesSeeded}`);
    console.log(`  memexesSkipped:   ${memexesSkipped}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[demo→starter sweep] failed:", err);
  process.exit(1);
});
