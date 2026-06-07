// spec-190 t-7 (dec-7) — import the repo's guide-content/ markdown into the
// guide_content table (the voice guide's knowledge store).
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/import-guide-content.ts          # full import
//   pnpm --filter @memex/server tsx scripts/import-guide-content.ts --check  # validate only (CI gate, dec-7c)
//
// Idempotent + non-destructive on content: upsertGuideChunk skips re-embedding
// any chunk whose content_hash is unchanged, and orphan rows (whose source file
// is gone) are pruned. Safe to run on every deploy.
//
// CI/CD wiring (dec-7b, "wired into the deploy, never run by hand"): the deploy
// step in packages/server/deploy.sh runs this AFTER migrations, bounded by
// `timeout` and non-gating (|| echo), so an import hiccup can never fail a live
// deploy — exactly the handhold/default-standards backfill precedent. Embeddings
// ride on resolveEmbeddingProvider() (Cohere default); with no provider, rows
// land vectorless and FTS covers.
//
// The freshness half of dec-7's enforcement loop is the Memex standard requiring
// guide-content updates alongside UI changes to a registered screen — see that
// standard (the human/agent half); this script is the machine half.

import {
  importGuideContent,
  GuideContentValidationError,
} from "../src/services/guide-content-import.js";

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  console.log(
    `[guide-content-import] starting${check ? " (check mode — validate only, no DB writes)" : ""}…`,
  );

  const summary = await importGuideContent({ check });

  for (const warning of summary.report.warnings) {
    console.warn(`[guide-content-import] ⚠ ${warning}`);
  }

  if (check) {
    console.log(
      `[guide-content-import] check passed — ${summary.filesScanned} file(s) valid, ${summary.report.warnings.length} warning(s).`,
    );
    process.exit(0);
  }

  console.log(
    `[guide-content-import] done — ${summary.filesScanned} file(s), ${summary.chunksSeen} chunk(s): ` +
      `${summary.chunksEmbedded} embedded, ${summary.chunksReused} reused, ` +
      `${summary.chunksWithoutVector} without vector; ${summary.rowsPruned} orphan row(s) pruned.`,
  );
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof GuideContentValidationError) {
    // Referential validation failure — print the errors and exit non-zero so a
    // CI check fails and a deploy step (bounded + non-gating) logs and moves on.
    console.error(err.message);
    process.exit(1);
  }
  console.error("[guide-content-import] failed:", err);
  process.exit(1);
});
