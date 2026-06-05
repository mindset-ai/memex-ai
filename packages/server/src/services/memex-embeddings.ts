// Embedding pipeline for Memex content (b-34 T-2 — generalised from the
// standards-only pipeline shipped in doc-8 t-5).
//
// Why this file exists:
//   The in-app and MCP agents use `search_memex` to look up Briefs, Standards,
//   free-form documents, and Decisions semantically. Each section of a
//   searchable doc needs a pgvector row in `doc_sections.embedding`. This
//   module is the single entry point that turns section content into a vector
//   and writes it back. Generic doc CRUD (sections.ts) calls these helpers as
//   a fire-and-forget side-effect — never blocking the user-visible write
//   path. A backfill script and a future cron can replay missing / stale rows
//   without touching the request flow.
//
//   Decision-table embeddings (separate column set on `decisions`) live in a
//   sibling helper added by T-4 — different table, different write path,
//   but same provider abstraction.
//
// Why raw SQL for the embedding column:
//   The three columns (embedding, embedding_model, embedding_updated_at) are NOT
//   modelled in db/schema.ts — adding them would force every DocSection test
//   fixture across the project to set them (see the matching note on docSections /
//   content_tsv). All reads/writes go through raw SQL with the table+column names
//   spelled out, including the pgvector text-encoded literal (`'[v1,v2,...]'`).
//
// What this module does NOT do:
//   - Throw on provider failure. The whole module is best-effort: if the OpenAI key
//     is missing, the network call times out, or the provider throws, we log and
//     return — the section row keeps its previous embedding, and the backfill
//     catches it next run. The user-visible write must never fail because
//     embedding glue broke.
//   - Decide WHICH provider runs. resolveEmbeddingProvider() owns provider choice
//     via env (EMBEDDING_PROVIDER / OPENAI_API_KEY / COHERE_API_KEY); we just take
//     whatever it returns and tag the row with provider.name.
//   - Filter by docType. Per b-34 D-2, every section flows through embedding
//     regardless of its parent doc's docType. The `kind` filter on `searchMemex`
//     segregates results at read time; gating writes is unnecessary and would
//     leave Spec / Document sections perpetually unsearchable.
//
// Concurrency note: each call issues its own UPDATE keyed on section id; concurrent
// embeds on the same section are last-write-wins on embedding + model + updated_at.
// Worst case is one wasted API call.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding-provider.js";

// Toggle stdout chatter without ripping out the calls. On by default in dev (matches
// the agent / drift-scan logger conventions).
const DEBUG_EMBED = process.env.DEBUG_AGENT !== "0";

function log(...args: unknown[]): void {
  if (!DEBUG_EMBED) return;
  // eslint-disable-next-line no-console
  console.log("[AGENT memex-embed]", ...args);
}

// pgvector accepts text-encoded vectors of the form '[v1,v2,...]' for both
// inserts and the `<=>` comparison literal. Stays consistent with the
// vector1536 customType encoding used elsewhere in the project.
function pgvectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// ── Provider resolution helper ─────────────────────────
// Tests inject a deterministic provider; production passes nothing and we resolve
// from env. Resolution returns null when no provider is configured (degraded mode).
//
// Re-exported under the legacy name `resolveStandardsEmbeddingProvider` so any
// transitional caller still importing the old symbol keeps working until the
// b-36 sweep removes the alias entirely.
export function resolveMemexEmbeddingProvider(): EmbeddingProvider | null {
  return resolveEmbeddingProvider();
}

// Internal helper: row shape for the section + parent doc lookup. Raw SQL so we
// don't have to bind to the docSections / documents Drizzle models (and we get the
// fields we actually need in one round-trip).
interface SectionWithDoc {
  id: string;
  doc_id: string;
  content: string;
}

async function loadSection(
  sectionId: string,
  memexId?: string,
): Promise<SectionWithDoc | null> {
  // drizzle's `execute` returns the postgres-js RowList shape directly on this
  // driver; cast to the row interface (matches the pattern in
  // src/__regression__/schema-state.regression.test.ts).
  //
  // When `memexId` is supplied we filter on it as a defence-in-depth check —
  // a stray caller that hands us a section UUID owned by another tenant won't
  // get an embedding written. Production callers already have the memexId in
  // scope (sections / standards services pass it in for the tenant guard above
  // the mutation). The argument is optional so legacy / test paths that
  // already trust the caller can skip it.
  const rows = (await db.execute(sql`
    SELECT s.id, s.doc_id, s.content
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    WHERE s.id = ${sectionId}
      ${memexId ? sql`AND d.memex_id = ${memexId}` : sql``}
    LIMIT 1
  `)) as unknown as SectionWithDoc[];
  return rows[0] ?? null;
}

async function writeEmbedding(
  sectionId: string,
  vec: number[],
  modelName: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE doc_sections
    SET embedding = ${pgvectorLiteral(vec)}::vector,
        embedding_model = ${modelName},
        embedding_updated_at = now()
    WHERE id = ${sectionId}
  `);
}

// ── embedAndStoreSection ────────────────────────────────
// Single-section path used by sections.ts::addSection / updateSection. Per
// b-34 D-2 there is no docType gate — every section flows through.

export interface EmbedSectionResult {
  status: "embedded" | "skipped-empty" | "skipped-no-provider" | "failed";
  reason?: string;
  model?: string;
}

export async function embedAndStoreSection(
  sectionId: string,
  options: { provider?: EmbeddingProvider | null; memexId?: string } = {},
): Promise<EmbedSectionResult> {
  const section = await loadSection(sectionId, options.memexId);
  if (!section) {
    log(`section ${sectionId} not found — nothing to embed`);
    return { status: "failed", reason: "section-not-found" };
  }

  const provider =
    options.provider !== undefined ? options.provider : resolveMemexEmbeddingProvider();
  if (!provider) {
    log(`no provider configured — leaving ${section.id} unembedded`);
    return { status: "skipped-no-provider" };
  }

  // Empty content: skip and don't waste a token on whitespace.
  const text = (section.content ?? "").trim();
  if (text.length === 0) {
    return { status: "skipped-empty" };
  }

  try {
    const [vector] = await provider.embed([text], "document");
    if (!vector) {
      log(`provider returned no vector for section ${section.id}`);
      return { status: "failed", reason: "provider-empty" };
    }
    await writeEmbedding(section.id, vector, provider.name);
    log(`embedded section ${section.id} using ${provider.name}`);
    return { status: "embedded", model: provider.name };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`embed failed for ${section.id}: ${reason}`);
    return { status: "failed", reason };
  }
}

// ── embedAndStoreDoc ───────────────────────────────────
// Whole-document path used by createStandard (and now usable by any caller
// that wants to bulk-embed a doc). Embeds every non-empty section in a
// single provider batch (capped by provider.maxBatchSize) so we pay one
// network round-trip instead of N.
//
// Per b-34 D-2 there is no docType filter — any doc with sections is fair
// game.

export interface EmbedDocResult {
  status: "embedded" | "skipped-no-doc" | "skipped-no-provider" | "failed";
  reason?: string;
  sectionsEmbedded: number;
  model?: string;
}

interface SectionRow {
  id: string;
  content: string;
}

export async function embedAndStoreDoc(
  docId: string,
  options: { provider?: EmbeddingProvider | null; memexId?: string } = {},
): Promise<EmbedDocResult> {
  // memexId-filtered lookup is defence-in-depth: a stray caller passing a
  // docId owned by another tenant short-circuits as "skipped-no-doc" instead
  // of (silently) re-embedding someone else's content. Production callers
  // always pass it; legacy / test paths that already trust the caller can
  // skip it.
  const docRows = (await db.execute(sql`
    SELECT id, handle
    FROM documents
    WHERE id = ${docId}
      ${options.memexId ? sql`AND memex_id = ${options.memexId}` : sql``}
    LIMIT 1
  `)) as unknown as Array<{ id: string; handle: string }>;
  const doc = docRows[0];
  if (!doc) {
    return { status: "skipped-no-doc", sectionsEmbedded: 0 };
  }

  const provider =
    options.provider !== undefined ? options.provider : resolveMemexEmbeddingProvider();
  if (!provider) {
    log(`no provider configured — leaving doc ${doc.handle} unembedded`);
    return { status: "skipped-no-provider", sectionsEmbedded: 0 };
  }

  const sections = (await db.execute(sql`
    SELECT id, content FROM doc_sections WHERE doc_id = ${doc.id} ORDER BY seq
  `)) as unknown as SectionRow[];

  const targets = sections
    .map((s) => ({ id: s.id, text: (s.content ?? "").trim() }))
    .filter((t) => t.text.length > 0);

  if (targets.length === 0) {
    return { status: "embedded", sectionsEmbedded: 0, model: provider.name };
  }

  let totalEmbedded = 0;
  try {
    for (let i = 0; i < targets.length; i += provider.maxBatchSize) {
      const batch = targets.slice(i, i + provider.maxBatchSize);
      const vectors = await provider.embed(batch.map((b) => b.text), "document");
      if (vectors.length !== batch.length) {
        log(
          `provider returned ${vectors.length} vectors for batch of ${batch.length} on ${doc.handle}`,
        );
        return {
          status: "failed",
          reason: "provider-vector-count-mismatch",
          sectionsEmbedded: totalEmbedded,
          model: provider.name,
        };
      }
      for (let j = 0; j < batch.length; j++) {
        await writeEmbedding(batch[j].id, vectors[j], provider.name);
        totalEmbedded += 1;
      }
    }

    log(`embedded ${totalEmbedded} section(s) of ${doc.handle} using ${provider.name}`);
    return { status: "embedded", sectionsEmbedded: totalEmbedded, model: provider.name };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`embed failed for ${doc.handle}: ${reason}`);
    return {
      status: "failed",
      reason,
      sectionsEmbedded: totalEmbedded,
      model: provider.name,
    };
  }
}

// ── Backfill ───────────────────────────────────────────
// Walks every section in the Memex (any docType, per b-34 D-2) that either
// has no embedding, or whose recorded model differs from the active provider,
// and embeds it. Used by `scripts/backfill-memex-embeddings.ts` (b-34 T-7,
// which extends this to also walk decisions) and by tests that need to
// force a re-embed.

export interface BackfillSectionResult {
  scanned: number;
  embedded: number;
  failed: number;
  skipped: number;
  reason?: string;
}

export async function backfillSectionEmbeddings(
  memexId: string,
  options: { provider?: EmbeddingProvider | null; force?: boolean } = {},
): Promise<BackfillSectionResult> {
  const provider =
    options.provider !== undefined ? options.provider : resolveMemexEmbeddingProvider();
  if (!provider) {
    return {
      scanned: 0,
      embedded: 0,
      failed: 0,
      skipped: 0,
      reason: "no-provider-configured",
    };
  }

  // `force=true` re-embeds every section in the Memex. Otherwise we pick rows
  // that lack an embedding OR whose recorded model doesn't match the active
  // provider (so an OpenAI→Cohere swap recomputes everything once).
  const rows = (await db.execute(sql`
    SELECT s.id, s.content
    FROM doc_sections s
    INNER JOIN documents d ON d.id = s.doc_id
    WHERE d.memex_id = ${memexId}
      ${options.force
        ? sql``
        : sql`AND (s.embedding IS NULL OR s.embedding_model IS DISTINCT FROM ${provider.name})`}
  `)) as unknown as SectionRow[];

  let embedded = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += provider.maxBatchSize) {
    const batch = rows.slice(i, i + provider.maxBatchSize);
    const targets = batch.filter((r) => (r.content ?? "").trim().length > 0);
    skipped += batch.length - targets.length;
    if (targets.length === 0) continue;

    try {
      const vectors = await provider.embed(
        targets.map((t) => t.content),
        "document",
      );
      if (vectors.length !== targets.length) {
        failed += targets.length;
        continue;
      }
      for (let j = 0; j < targets.length; j++) {
        await writeEmbedding(targets[j].id, vectors[j], provider.name);
        embedded += 1;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`backfill batch failed: ${reason}`);
      failed += targets.length;
    }
  }

  return { scanned: rows.length, embedded, failed, skipped };
}

// ══════════════════════════════════════════════════════════
// Decision embeddings (b-34 T-4)
// ══════════════════════════════════════════════════════════
//
// Decisions live in their own table — not in doc_sections — but follow the same
// embedding contract: a single text chunk per decision (title + context +
// resolution, whatever's present), 1536-dim vector, model column, fire-and-
// forget hook on every write that mutates the embedded text.
//
// Schema columns are added by migration 0052_add_decisions_embeddings.sql and
// are NOT modelled in db/schema.ts — same convention as doc_sections.embedding.

interface DecisionRow {
  id: string;
  title: string;
  context: string | null;
  resolution: string | null;
  doc_id: string;
}

async function loadDecision(
  decisionId: string,
  memexId?: string,
): Promise<DecisionRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, title, context, resolution, doc_id
    FROM decisions
    WHERE id = ${decisionId}
      ${memexId ? sql`AND memex_id = ${memexId}` : sql``}
    LIMIT 1
  `)) as unknown as DecisionRow[];
  return rows[0] ?? null;
}

// Concatenate the searchable text fields. Decisions can be partially populated
// (a freshly created decision has no resolution yet), so each piece is
// optional. Empty strings collapse so the search index doesn't waste a token
// on whitespace-only chunks.
export function buildDecisionEmbeddingText(d: {
  title: string;
  context?: string | null;
  resolution?: string | null;
}): string {
  return [d.title, d.context ?? "", d.resolution ?? ""]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

async function writeDecisionEmbedding(
  decisionId: string,
  vec: number[],
  modelName: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE decisions
    SET embedding = ${pgvectorLiteral(vec)}::vector,
        embedding_model = ${modelName},
        embedding_updated_at = now()
    WHERE id = ${decisionId}
  `);
}

export interface EmbedDecisionResult {
  status: "embedded" | "skipped-empty" | "skipped-no-provider" | "failed";
  reason?: string;
  model?: string;
}

export async function embedAndStoreDecision(
  decisionId: string,
  options: { provider?: EmbeddingProvider | null; memexId?: string } = {},
): Promise<EmbedDecisionResult> {
  const decision = await loadDecision(decisionId, options.memexId);
  if (!decision) {
    log(`decision ${decisionId} not found — nothing to embed`);
    return { status: "failed", reason: "decision-not-found" };
  }

  const provider =
    options.provider !== undefined ? options.provider : resolveMemexEmbeddingProvider();
  if (!provider) {
    log(`no provider configured — leaving decision ${decision.id} unembedded`);
    return { status: "skipped-no-provider" };
  }

  const text = buildDecisionEmbeddingText(decision);
  if (text.length === 0) {
    return { status: "skipped-empty" };
  }

  try {
    const [vector] = await provider.embed([text], "document");
    if (!vector) {
      log(`provider returned no vector for decision ${decision.id}`);
      return { status: "failed", reason: "provider-empty" };
    }
    await writeDecisionEmbedding(decision.id, vector, provider.name);
    log(`embedded decision ${decision.id} using ${provider.name}`);
    return { status: "embedded", model: provider.name };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`embed failed for decision ${decision.id}: ${reason}`);
    return { status: "failed", reason };
  }
}

// Backfill helper for decisions — same shape as backfillSectionEmbeddings,
// but walks `decisions` instead of `doc_sections`. Used by the b-34 T-7
// CLI script alongside the section backfill.
interface DecisionBackfillRow {
  id: string;
  title: string;
  context: string | null;
  resolution: string | null;
}

export async function backfillDecisionEmbeddings(
  memexId: string,
  options: { provider?: EmbeddingProvider | null; force?: boolean } = {},
): Promise<BackfillSectionResult> {
  const provider =
    options.provider !== undefined ? options.provider : resolveMemexEmbeddingProvider();
  if (!provider) {
    return {
      scanned: 0,
      embedded: 0,
      failed: 0,
      skipped: 0,
      reason: "no-provider-configured",
    };
  }

  const rows = (await db.execute(sql`
    SELECT id, title, context, resolution
    FROM decisions
    WHERE memex_id = ${memexId}
      ${options.force
        ? sql``
        : sql`AND (embedding IS NULL OR embedding_model IS DISTINCT FROM ${provider.name})`}
  `)) as unknown as DecisionBackfillRow[];

  let embedded = 0;
  let failed = 0;
  let skipped = 0;

  // Build text per row, drop empties, batch through the provider.
  const targets = rows
    .map((r) => ({ id: r.id, text: buildDecisionEmbeddingText(r) }))
    .filter((t) => {
      if (t.text.length === 0) {
        skipped += 1;
        return false;
      }
      return true;
    });

  for (let i = 0; i < targets.length; i += provider.maxBatchSize) {
    const batch = targets.slice(i, i + provider.maxBatchSize);
    try {
      const vectors = await provider.embed(batch.map((b) => b.text), "document");
      if (vectors.length !== batch.length) {
        failed += batch.length;
        continue;
      }
      for (let j = 0; j < batch.length; j++) {
        await writeDecisionEmbedding(batch[j].id, vectors[j], provider.name);
        embedded += 1;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`decision backfill batch failed: ${reason}`);
      failed += batch.length;
    }
  }

  return { scanned: rows.length, embedded, failed, skipped };
}

// ══════════════════════════════════════════════════════════
// Issue embeddings (spec-112 t-3)
// ══════════════════════════════════════════════════════════
//
// Issues live in their own table (0068_issues.sql) — not in doc_sections — but
// follow the same embedding contract as decisions: a single text chunk per
// Issue (title + body), 1536-dim vector, model column, fire-and-forget hook on
// every write that mutates the embedded text (create + update in services/
// issues.ts). This is what lets Issues ride the SAME RRF FTS+vector search path
// (ac-13) — no parallel search infra (s-4, "no new infrastructure").
//
// Schema columns are added by migration 0068_issues.sql and are NOT modelled in
// db/schema.ts — same convention as doc_sections.embedding / decisions.embedding.

interface IssueRow {
  id: string;
  title: string;
  body: string | null;
  doc_id: string;
}

async function loadIssue(
  issueId: string,
  memexId?: string,
): Promise<IssueRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, title, body, doc_id
    FROM issues
    WHERE id = ${issueId}
      ${memexId ? sql`AND memex_id = ${memexId}` : sql``}
    LIMIT 1
  `)) as unknown as IssueRow[];
  return rows[0] ?? null;
}

// Concatenate the searchable text fields. An Issue always has a title and body
// (both NOT NULL in the schema), but body may be effectively empty whitespace.
// Empty strings collapse so the search index doesn't waste a token on
// whitespace-only chunks — matches buildDecisionEmbeddingText.
export function buildIssueEmbeddingText(i: {
  title: string;
  body?: string | null;
}): string {
  return [i.title, i.body ?? ""]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");
}

async function writeIssueEmbedding(
  issueId: string,
  vec: number[],
  modelName: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE issues
    SET embedding = ${pgvectorLiteral(vec)}::vector,
        embedding_model = ${modelName},
        embedding_updated_at = now()
    WHERE id = ${issueId}
  `);
}

export interface EmbedIssueResult {
  status: "embedded" | "skipped-empty" | "skipped-no-provider" | "failed";
  reason?: string;
  model?: string;
}

export async function embedAndStoreIssue(
  issueId: string,
  options: { provider?: EmbeddingProvider | null; memexId?: string } = {},
): Promise<EmbedIssueResult> {
  const issue = await loadIssue(issueId, options.memexId);
  if (!issue) {
    log(`issue ${issueId} not found — nothing to embed`);
    return { status: "failed", reason: "issue-not-found" };
  }

  const provider =
    options.provider !== undefined ? options.provider : resolveMemexEmbeddingProvider();
  if (!provider) {
    log(`no provider configured — leaving issue ${issue.id} unembedded`);
    return { status: "skipped-no-provider" };
  }

  const text = buildIssueEmbeddingText(issue);
  if (text.length === 0) {
    return { status: "skipped-empty" };
  }

  try {
    const [vector] = await provider.embed([text], "document");
    if (!vector) {
      log(`provider returned no vector for issue ${issue.id}`);
      return { status: "failed", reason: "provider-empty" };
    }
    await writeIssueEmbedding(issue.id, vector, provider.name);
    log(`embedded issue ${issue.id} using ${provider.name}`);
    return { status: "embedded", model: provider.name };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`embed failed for issue ${issue.id}: ${reason}`);
    return { status: "failed", reason };
  }
}

// Backfill helper for issues — same shape as backfillDecisionEmbeddings, but
// walks `issues` instead of `decisions`. Re-embeds rows that lack an embedding
// OR whose recorded model doesn't match the active provider (force=true
// re-embeds everything).
interface IssueBackfillRow {
  id: string;
  title: string;
  body: string | null;
}

export async function backfillIssueEmbeddings(
  memexId: string,
  options: { provider?: EmbeddingProvider | null; force?: boolean } = {},
): Promise<BackfillSectionResult> {
  const provider =
    options.provider !== undefined ? options.provider : resolveMemexEmbeddingProvider();
  if (!provider) {
    return {
      scanned: 0,
      embedded: 0,
      failed: 0,
      skipped: 0,
      reason: "no-provider-configured",
    };
  }

  const rows = (await db.execute(sql`
    SELECT id, title, body
    FROM issues
    WHERE memex_id = ${memexId}
      ${options.force
        ? sql``
        : sql`AND (embedding IS NULL OR embedding_model IS DISTINCT FROM ${provider.name})`}
  `)) as unknown as IssueBackfillRow[];

  let embedded = 0;
  let failed = 0;
  let skipped = 0;

  // Build text per row, drop empties, batch through the provider.
  const targets = rows
    .map((r) => ({ id: r.id, text: buildIssueEmbeddingText(r) }))
    .filter((t) => {
      if (t.text.length === 0) {
        skipped += 1;
        return false;
      }
      return true;
    });

  for (let i = 0; i < targets.length; i += provider.maxBatchSize) {
    const batch = targets.slice(i, i + provider.maxBatchSize);
    try {
      const vectors = await provider.embed(batch.map((b) => b.text), "document");
      if (vectors.length !== batch.length) {
        failed += batch.length;
        continue;
      }
      for (let j = 0; j < batch.length; j++) {
        await writeIssueEmbedding(batch[j].id, vectors[j], provider.name);
        embedded += 1;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`issue backfill batch failed: ${reason}`);
      failed += batch.length;
    }
  }

  return { scanned: rows.length, embedded, failed, skipped };
}
