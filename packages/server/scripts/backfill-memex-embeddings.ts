// Backfill embeddings for every searchable entity in a Memex — sections of
// every supported docType (spec, standard, document, etc.) AND decisions.
// (b-34 T-7 — generalised from the standards-only backfill that shipped in
// doc-8.)
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/backfill-memex-embeddings.ts
//   pnpm --filter @memex/server tsx scripts/backfill-memex-embeddings.ts <memexId>
//   pnpm --filter @memex/server tsx scripts/backfill-memex-embeddings.ts <memexId> --force
//
// `memexId` is the UUID from the `memexes` table. Run without an id to walk
// every Memex in the database.
//
// Prereqs: same env as the server. EMBEDDING_PROVIDER / OPENAI_API_KEY /
// COHERE_API_KEY must resolve to a provider; if none is set the script exits
// non-zero with a clear message rather than silently no-op'ing.
//
// Idempotency: the per-row predicate `(embedding IS NULL OR embedding_model
// IS DISTINCT FROM provider.name)` means a second run on a fully-embedded
// Memex does zero work. `--force` re-embeds everything (use after switching
// embedding providers if you want fresh vectors immediately rather than
// waiting for the next write).
//
// Why a script (not a route): backfill is operator-grade — it might burn API
// dollars on thousands of sections / decisions — so we want it triggered
// explicitly from a dev/prod shell, not from a button click.

import { db } from "../src/db/connection.js";
import { memexes } from "../src/db/schema.js";
import {
  backfillSectionEmbeddings,
  backfillDecisionEmbeddings,
  resolveMemexEmbeddingProvider,
} from "../src/services/memex-embeddings.js";

interface MemexBackfillTotal {
  sectionsScanned: number;
  sectionsEmbedded: number;
  sectionsFailed: number;
  sectionsSkipped: number;
  decisionsScanned: number;
  decisionsEmbedded: number;
  decisionsFailed: number;
  decisionsSkipped: number;
}

async function backfillOneMemex(
  memexId: string,
  opts: { force: boolean },
): Promise<MemexBackfillTotal> {
  const [sections, decisions] = await Promise.all([
    backfillSectionEmbeddings(memexId, { force: opts.force }),
    backfillDecisionEmbeddings(memexId, { force: opts.force }),
  ]);

  return {
    sectionsScanned: sections.scanned,
    sectionsEmbedded: sections.embedded,
    sectionsFailed: sections.failed,
    sectionsSkipped: sections.skipped,
    decisionsScanned: decisions.scanned,
    decisionsEmbedded: decisions.embedded,
    decisionsFailed: decisions.failed,
    decisionsSkipped: decisions.skipped,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const memexIdArg = args.find((a) => !a.startsWith("--"));
  const force = args.includes("--force");

  const provider = resolveMemexEmbeddingProvider();
  if (!provider) {
    console.error(
      "No embedding provider configured. Set EMBEDDING_PROVIDER + the matching API key (OPENAI_API_KEY / COHERE_API_KEY) and re-run.",
    );
    process.exit(1);
  }

  const memexIds: string[] = memexIdArg
    ? [memexIdArg]
    : (await db.select({ id: memexes.id }).from(memexes)).map((r) => r.id);

  console.log(
    `Backfill provider=${provider.name} memexes=${memexIds.length} force=${force}`,
  );

  const totals: MemexBackfillTotal = {
    sectionsScanned: 0,
    sectionsEmbedded: 0,
    sectionsFailed: 0,
    sectionsSkipped: 0,
    decisionsScanned: 0,
    decisionsEmbedded: 0,
    decisionsFailed: 0,
    decisionsSkipped: 0,
  };

  for (const memexId of memexIds) {
    const result = await backfillOneMemex(memexId, { force });
    totals.sectionsScanned += result.sectionsScanned;
    totals.sectionsEmbedded += result.sectionsEmbedded;
    totals.sectionsFailed += result.sectionsFailed;
    totals.sectionsSkipped += result.sectionsSkipped;
    totals.decisionsScanned += result.decisionsScanned;
    totals.decisionsEmbedded += result.decisionsEmbedded;
    totals.decisionsFailed += result.decisionsFailed;
    totals.decisionsSkipped += result.decisionsSkipped;

    console.log(
      `  memex=${memexId} ` +
        `sections(scanned=${result.sectionsScanned} embedded=${result.sectionsEmbedded} failed=${result.sectionsFailed} skipped=${result.sectionsSkipped}) ` +
        `decisions(scanned=${result.decisionsScanned} embedded=${result.decisionsEmbedded} failed=${result.decisionsFailed} skipped=${result.decisionsSkipped})`,
    );
  }

  console.log(
    `Done. sections(scanned=${totals.sectionsScanned} embedded=${totals.sectionsEmbedded} failed=${totals.sectionsFailed} skipped=${totals.sectionsSkipped}) ` +
      `decisions(scanned=${totals.decisionsScanned} embedded=${totals.decisionsEmbedded} failed=${totals.decisionsFailed} skipped=${totals.decisionsSkipped})`,
  );
  process.exit(totals.sectionsFailed + totals.decisionsFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
