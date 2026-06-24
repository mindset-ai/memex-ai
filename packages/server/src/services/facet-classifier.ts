// spec-340 t-3 — the clause→facet classifier + standard-level pill rollup.
//
// Supply side of the mechanism (dec-2): at standard-authoring time, classify each
// clause against the ORG's current facet vocabulary and store auto-assigned tags.
// Auto-assigned, NOT a hand-maintained join — the distinction the spec-193 guard
// reconciliation (t-9) rides.
//
// The LLM call (classifyClauseWithLlm) is separated from the deterministic
// persistence (tagClause) and rollup (standardPillSet) so the DB logic is tested
// without the model. Structured output via Anthropic `messages.parse` +
// zodOutputFormat — same path as the clause-translator sibling (spec-150 dec-6),
// and the client is injectable so tests run key-free.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, facets, standardClauses, standardClauseFacets } from "../db/schema.js";
import { getAnthropicClient } from "../agent/anthropic-client.js";
import { orgIdForMemex } from "./shared/memex-ownership.js";
import { ValidationError } from "../types/errors.js";

// Same model the clause-translator + chat route use (spec-150 / routes/llm.ts).
// Tunable; classification is a good fit for a cheaper tier later.
const MODEL = "claude-sonnet-4-5-20250929";

// Structured-output contract: the facet slugs the clause GOVERNS. Empty = the
// clause governs nothing (explicit none). Kept to a plain string array so the
// JSON Schema constrains cleanly; unknown slugs are filtered after decode.
export const FacetVerdictSchema = z.object({
  facetKeys: z.array(z.string()),
});
export type FacetVerdict = z.infer<typeof FacetVerdictSchema>;

export interface VocabFacet {
  id: string;
  key: string;
  description: string;
}

// Minimal Anthropic surface (messages.parse with structured outputs), so tests
// can inject a stub client.
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
   * (clauseBody, vocab). Returns the governing facet keys ([] = none). When set,
   * the LLM is never called — used to test the orchestration + persistence.
   */
  classify?: (clauseBody: string, vocab: VocabFacet[]) => Promise<string[]> | string[];
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
 * Returned keys are always a subset of the supplied vocabulary (a hallucinated
 * slug is dropped, never persisted).
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
 * Persist a clause's facet membership (deterministic, no LLM). Replaces any prior
 * tags for the clause, then writes EITHER one member row per facet key OR a single
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

/** Load the org's facet vocabulary for a memex (the classifier input). */
export async function vocabForMemex(memexId: string): Promise<VocabFacet[]> {
  const orgId = await orgIdForMemex(memexId);
  if (!orgId) return [];
  return db
    .select({ id: facets.id, key: facets.key, description: facets.description })
    .from(facets)
    .where(eq(facets.orgId, orgId));
}

export interface OrgFacet {
  key: string;
  name: string | null;
  description: string;
  ord: number;
}

/** The org's full facet vocabulary for display (the `facets` tool's `list` verb), ordered by ord. */
export async function listOrgFacets(memexId: string): Promise<OrgFacet[]> {
  const orgId = await orgIdForMemex(memexId);
  if (!orgId) return [];
  return db
    .select({ key: facets.key, name: facets.name, description: facets.description, ord: facets.ord })
    .from(facets)
    .where(eq(facets.orgId, orgId))
    .orderBy(asc(facets.ord));
}

function facetRehandMessage(vocab: VocabFacet[], lead: string): string {
  const keys = vocab.map((f) => f.key).join(", ");
  return (
    `${lead} Valid facets for this org: [${keys}]. Call the facets tool (verb: 'list') for their ` +
    `descriptions, classify the clause, and pass the governing slugs — or [] if the clause governs nothing.`
  );
}

/**
 * Validate a clause's facet verdict against the org vocabulary (dec-8). Throws a
 * re-handing ValidationError when the verdict is missing-while-required or names
 * an unknown facet — the error lists the org's valid keys and points at the
 * facets list verb, so the agent recovers the vocabulary from the rejection.
 * Returns the vocab so the caller can tag without re-loading. Call BEFORE
 * creating/updating the clause so a rejected verdict leaves no orphan.
 */
export async function validateClauseFacets(
  memexId: string,
  facetKeys: string[] | undefined,
  opts: { required: boolean },
): Promise<VocabFacet[]> {
  const vocab = await vocabForMemex(memexId);
  if (facetKeys === undefined) {
    if (!opts.required) return vocab;
    throw new ValidationError(
      facetRehandMessage(
        vocab,
        "add_clause requires a facets verdict — the practice areas this clause governs (or [] if it governs nothing).",
      ),
    );
  }
  const known = new Set(vocab.map((f) => f.key));
  const unknown = facetKeys.filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new ValidationError(facetRehandMessage(vocab, `Unknown facet(s): ${unknown.join(", ")}.`));
  }
  return vocab;
}

/**
 * Classify every (non-deleted) clause of a standard and store its tags. The
 * per-clause verdict is the classifier's; the persistence is deterministic.
 */
export async function classifyStandard(
  memexId: string,
  docId: string,
  opts: ClassifyOptions = {},
): Promise<void> {
  const vocab = await vocabForMemex(memexId);
  const clauses = await db
    .select()
    .from(standardClauses)
    .where(and(eq(standardClauses.docId, docId), ne(standardClauses.status, "deleted")));
  for (const cl of clauses) {
    const keys = await classifyClauseWithLlm(cl.body, vocab, opts);
    await tagClause(memexId, cl.id, keys, vocab);
  }
}

/**
 * spec-340 t-11 — backfill: classify every clause of every standard in a memex
 * (dec-8). The one-off `tsx` script calls this with the REAL Anthropic client;
 * tests inject `opts.classify`. Idempotent (tagClause replaces a clause's tags).
 * Returns counts for the operator's log.
 */
export async function backfillFacetTagsForMemex(
  memexId: string,
  opts: ClassifyOptions = {},
): Promise<{ standards: number; clauses: number }> {
  const standardDocs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.memexId, memexId), eq(documents.docType, "standard")));
  let clauses = 0;
  for (const doc of standardDocs) {
    const cls = await db
      .select({ id: standardClauses.id })
      .from(standardClauses)
      .where(and(eq(standardClauses.docId, doc.id), ne(standardClauses.status, "deleted")));
    clauses += cls.length;
    await classifyStandard(memexId, doc.id, opts);
  }
  return { standards: standardDocs.length, clauses };
}

/**
 * The standard-level pill set: the UNION of member facet keys over the doc's
 * clauses. The inner join on facet_id excludes explicit-none markers, so
 * rationale/example clauses never dilute the pill (dec-2 / s-2).
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
