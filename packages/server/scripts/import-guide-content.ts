// spec-190 t-7 (dec-7) — import the repo's guide-content/ markdown into the
// guide_content table (the voice guide's knowledge store).
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/import-guide-content.ts          # full app import
//   pnpm --filter @memex/server tsx scripts/import-guide-content.ts --check  # validate only (CI gate, dec-7c)
//
// spec-222 t-8 (dec-3) — website corpus ingestion. The marketing site publishes a
// FLAT llms-full.txt (no frontmatter); ingest it under the memex-website surface,
// reusing the same chunk/hash/upsert primitives. Same idempotency + bounded,
// non-gating posture as the app import:
//   pnpm --filter @memex/server tsx scripts/import-guide-content.ts \
//     --surface=memex-website --source=https://memex.ai/llms-full.txt
//   …--surface=memex-website --source=/path/to/llms-full.txt   # local file
// The website import prunes orphans SCOPED to the memex-website surface only — it
// never touches the app corpus, and vice versa.
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
  importWebsiteCorpus,
  GuideContentValidationError,
} from "../src/services/guide-content-import.js";

/** Pull a `--flag=value` argument's value (or undefined when absent). */
function argValue(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function runWebsiteImport(source: string, check: boolean): Promise<void> {
  console.log(
    `[guide-content-import] starting website corpus import from ${source}` +
      `${check ? " (check mode — fetch + chunk only, no DB writes)" : ""}…`,
  );
  // A URL goes through fetch; anything else is treated as a local file path.
  const isUrl = /^https?:\/\//i.test(source);
  const summary = await importWebsiteCorpus({
    source: isUrl ? { url: source } : { path: source },
    check,
  });
  console.log(
    `[guide-content-import] website done — ${summary.chunksSeen} chunk(s): ` +
      `${summary.chunksEmbedded} embedded, ${summary.chunksReused} reused, ` +
      `${summary.chunksWithoutVector} without vector; ${summary.rowsPruned} orphan row(s) pruned.`,
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");

  // spec-222 t-8: website-surface mode is selected by --surface=memex-website.
  const surface = argValue("surface");
  if (surface === "memex-website") {
    const source = argValue("source");
    if (!source) {
      console.error(
        "[guide-content-import] --surface=memex-website requires --source=<url|path>",
      );
      process.exit(1);
    }
    await runWebsiteImport(source, check);
    return;
  }
  if (surface && surface !== "memex-app") {
    console.error(
      `[guide-content-import] unknown --surface=${surface} (expected memex-app | memex-website)`,
    );
    process.exit(1);
  }

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
