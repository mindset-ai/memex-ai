// spec-340 t-4 — the clause→facet classifier (the LLM ENGINE) + standard-level pill
// rollup.
//
// dec-8: classification is AGENT-DRIVEN. The ONLY caller of this engine is the local,
// operator-run backfill script (scripts/backfill-facet-tags.ts) and tests — NO server
// request/write path imports it (enforced by
// facet-classifier-no-request-path.regression.test.ts). This Spec's deploy does NOT
// run the backfill; it is a local one-off. Authoring-time classification (the
// add_clause hard-fail) is deferred to phase 2 (spec-423).
//
// Parallel with BOUNDED CONCURRENCY + Claude Opus 4.8 (the model the coding agent
// itself runs) — ac-39. The LLM call (classifyClauseWithLlm) is separated from the
// deterministic persistence (tagClause) and rollup (standardPillSet) so the DB logic
// is tested without the model. Structured output via Anthropic `messages.parse` +
// zodOutputFormat — same path as the clause-translator sibling (spec-150 dec-6) — and
// the client is injectable so tests run key-free.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, facets, standardClauses, standardClauseFacets } from "../db/schema.js";
import { getAnthropicClient } from "../agent/anthropic-client.js";
import { vocabForMemex, type VocabFacet } from "./facet-vocab.js";

// Claude Opus 4.8 — the model the coding agent itself runs (dec-8 / ac-39). The
// classifier is a one-off local backfill, so it runs on the most capable tier.
const MODEL = "claude-opus-4-8";

// How many clauses to classify concurrently. Bounded so a large standards corpus
// doesn't open hundreds of simultaneous Anthropic requests (ac-39: bounded concurrency).
const CONCURRENCY = 8;

// Structured-output contract: the facet slugs the clause GOVERNS. Empty = the clause
// governs nothing (explicit none). Kept to a plain string array so the JSON Schema
// constrains cleanly; unknown slugs are filtered after decode.
export const FacetVerdictSchema = z.object({
  facetKeys: z.array(z.string()),
});
export type FacetVerdict = z.infer<typeof FacetVerdictSchema>;

// Minimal Anthropic surface (messages.parse with structured outputs) so tests can
// inject a stub client.
export interface AnthropicLike {
  messages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: (args: any) => Promise<{ parsed_output: FacetVerdict | null }>;
  };
}

export interface ClassifyOptions {
  /** Injected client for tests; defaults to the shared Anthropic client. */
  client?: AnthropicLike;
  /**
   * Test seam: bypass the model entirely with a deterministic classifier over
   * (clauseBody, vocab). Returns the governing facet keys ([] = none). When set, the
   * LLM is never called — used to test the orchestration + persistence key-free.
   */
  classify?: (clauseBody: string, vocab: VocabFacet[]) => Promise<string[]> | string[];
}

// Run `fn` over `items` with at most `limit` in flight at once — bounded-concurrency
// parallelism (ac-39). Order of results matches input order.
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function classifierSystemPrompt(vocab: VocabFacet[]): string {
  const lines = vocab.map((f) => `- ${f.key}: ${f.description}`).join("\n");
  return `You classify a single clause from a standards document against a fixed vocabulary of cross-cutting practice areas ("facets").

Return ONLY the facet slugs this clause GOVERNS — i.e. the clause sets a RULE about that area — judged against each facet's description. A clause that merely MENTIONS, motivates, or illustrates an area does NOT govern it. Many clauses (rationale, examples, background) govern NOTHING: return an empty list for those. Use only slugs from the vocabulary below; never invent one.

Vocabulary:
${lines}`;
}

function filterToVocab(keys: string[], vocab: VocabFacet[]): string[] {
  const known = new Set(vocab.map((f) => f.key));
  return [...new Set(keys.filter((k) => known.has(k)))];
}

/**
 * Classify ONE clause → the member facet keys it governs ([] = governs nothing).
 * Returned keys are always a subset of the supplied vocabulary (a hallucinated slug
 * is dropped, never persisted).
 */
export async function classifyClauseWithLlm(
  clauseBody: string,
  vocab: VocabFacet[],
  opts: ClassifyOptions = {},
): Promise<string[]> {
  if (opts.classify) {
    return filterToVocab(await opts.classify(clauseBody, vocab), vocab);
  }
  const client = opts.client ?? (getAnthropicClient() as unknown as AnthropicLike);
  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 1024,
    system: classifierSystemPrompt(vocab),
    output_config: { format: zodOutputFormat(FacetVerdictSchema) },
    messages: [{ role: "user", content: `Clause:\n\n${clauseBody}` }],
  });
  if (!message.parsed_output) {
    throw new Error("facet-classifier: structured output returned no parsed_output");
  }
  return filterToVocab(message.parsed_output.facetKeys, vocab);
}

/**
 * Persist a clause's facet membership (deterministic, no LLM). Replaces any prior tags
 * for the clause, then writes EITHER one member row per facet key OR a single
 * explicit-none marker (facet_id NULL) when keys is empty — so the tri-state
 * (governs / explicit-none / not-yet-classified) holds. Idempotent: re-tagging a
 * clause overwrites its prior verdict.
 */
export async function tagClause(
  memexId: string,
  clauseId: string,
  facetKeys: string[],
  vocab: VocabFacet[],
): Promise<void> {
  const idByKey = new Map(vocab.map((f) => [f.key, f.id]));
  const keys = [...new Set(facetKeys.filter((k) => idByKey.has(k)))];
  await db.transaction(async (tx) => {
    await tx.delete(standardClauseFacets).where(eq(standardClauseFacets.clauseId, clauseId));
    if (keys.length === 0) {
      await tx.insert(standardClauseFacets).values({ memexId, clauseId, facetId: null });
    } else {
      await tx
        .insert(standardClauseFacets)
        .values(keys.map((k) => ({ memexId, clauseId, facetId: idByKey.get(k)! })));
    }
  });
}

// Classify + tag a set of clauses with bounded-concurrency parallelism (ac-39).
async function classifyAndTagClauses(
  memexId: string,
  clauses: { id: string; body: string }[],
  vocab: VocabFacet[],
  opts: ClassifyOptions,
): Promise<void> {
  await mapWithConcurrency(clauses, CONCURRENCY, async (cl) => {
    const keys = await classifyClauseWithLlm(cl.body, vocab, opts);
    await tagClause(memexId, cl.id, keys, vocab);
  });
}

/**
 * Classify every (non-deleted) clause of a standard and store its tags. The per-clause
 * verdict is the classifier's; the persistence is deterministic. Clauses are classified
 * in parallel (bounded).
 */
export async function classifyStandard(
  memexId: string,
  docId: string,
  opts: ClassifyOptions = {},
): Promise<void> {
  const vocab = await vocabForMemex(memexId);
  const clauses = await db
    .select({ id: standardClauses.id, body: standardClauses.body })
    .from(standardClauses)
    .where(and(eq(standardClauses.docId, docId), ne(standardClauses.status, "deleted")));
  await classifyAndTagClauses(memexId, clauses, vocab, opts);
}

/**
 * spec-340 t-4 — backfill: classify every clause of every standard in a memex (dec-8).
 * The one-off `tsx` script calls this with the REAL Anthropic client; tests inject
 * `opts.classify`. All clauses across all standards are classified in ONE
 * bounded-concurrency pool. Idempotent (tagClause replaces a clause's tags). Returns
 * counts for the operator's log.
 */
export async function backfillFacetTagsForMemex(
  memexId: string,
  opts: ClassifyOptions = {},
): Promise<{ standards: number; clauses: number }> {
  const vocab = await vocabForMemex(memexId);
  const standardDocs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.docType, "standard")));

  const allClauses: { id: string; body: string }[] = [];
  for (const doc of standardDocs) {
    const cls = await db
      .select({ id: standardClauses.id, body: standardClauses.body })
      .from(standardClauses)
      .where(and(eq(standardClauses.docId, doc.id), ne(standardClauses.status, "deleted")));
    allClauses.push(...cls);
  }

  await classifyAndTagClauses(memexId, allClauses, vocab, opts);
  return { standards: standardDocs.length, clauses: allClauses.length };
}

/**
 * The standard-level pill set: the UNION of member facet keys over the doc's clauses.
 * The inner join on facet_id excludes explicit-none markers, so rationale/example
 * clauses never dilute the pill (dec-2 / s-2).
 */
export async function standardPillSet(memexId: string, docId: string): Promise<string[]> {
  const rows = await db
    .select({ key: facets.key })
    .from(standardClauseFacets)
    .innerJoin(standardClauses, eq(standardClauseFacets.clauseId, standardClauses.id))
    .innerJoin(facets, eq(standardClauseFacets.facetId, facets.id))
    .where(and(eq(standardClauses.docId, docId), eq(standardClauseFacets.memexId, memexId)));
  return [...new Set(rows.map((r) => r.key))].sort();
}
