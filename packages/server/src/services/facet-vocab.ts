// spec-340 — facet vocabulary READ helpers (no LLM).
//
// Deliberately separated from facet-classifier.ts (the LLM engine) so the request
// path — the `facets` list tool (t-6) — can read the vocabulary WITHOUT importing the
// classifier. dec-8: no server request/write path may import the LLM classifier; the
// no-import guard (facet-classifier-no-request-path.regression.test.ts) bans the whole
// facet-classifier module from request-path dirs, so the vocabulary reads live here.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, standardClauseFacets } from "../db/schema.js";
import { ownerForMemex } from "./shared/memex-ownership.js";
import { ValidationError } from "../types/errors.js";
import { mutate, type RequestCtx } from "./mutate.js";

// The classifier's input shape: id + key + the disambiguating description.
export interface VocabFacet {
  id: string;
  key: string;
  description: string;
}

// The display shape for the `facets` list verb (t-6).
export interface OwnerFacet {
  key: string;
  name: string | null;
  description: string;
  ord: number;
}

// Load a memex's facet vocabulary (id/key/description) for the classifier — resolved
// via the polymorphic owner (dec-7). Empty when the owner can't be resolved.
export async function vocabForMemex(memexId: string): Promise<VocabFacet[]> {
  const owner = await ownerForMemex(memexId);
  if (!owner) return [];
  return db
    .select({ id: facets.id, key: facets.key, description: facets.description })
    .from(facets)
    .where(and(eq(facets.ownerType, owner.ownerType), eq(facets.ownerId, owner.ownerId)));
}

// The owner's full facet vocabulary for display (the `facets` list verb), ordered by
// ord. Resolved via the same polymorphic owner rule as seeding (dec-7).
export async function listFacetsForMemex(memexId: string): Promise<OwnerFacet[]> {
  const owner = await ownerForMemex(memexId);
  if (!owner) return [];
  return db
    .select({ key: facets.key, name: facets.name, description: facets.description, ord: facets.ord })
    .from(facets)
    .where(and(eq(facets.ownerType, owner.ownerType), eq(facets.ownerId, owner.ownerId)))
    .orderBy(asc(facets.ord));
}

// ── Authoring-time clause classification (spec-423 t-6, dec-9) ─────────────────
// add_clause hard-requires a facet verdict; edit_clause's is optional. The
// validation lives HERE (no-LLM) and is imported into agent/handlers/sections.ts
// from here — NEVER from facet-classifier.ts (the no-request-path guard).

export function reHandClause(vocab: OwnerFacet[], lead: string): string {
  const keys = vocab.map((f) => f.key).join(", ");
  return (
    `${lead} Provide a facet verdict: an array of facet keys from [${keys}], or [] for ` +
    `"governs nothing" (a definition / example / rationale clause). Call the \`facets\` ` +
    `tool (verb 'list') to re-read the vocabulary.`
  );
}

/**
 * Validate a clause facet verdict against the owner's live vocabulary (dec-9).
 *   • Returns null when the owner has NO vocabulary — nothing to classify against, so
 *     no verdict is required (keeps add_clause working on a vocab-less Memex).
 *   • Throws a re-handing ValidationError when `verdict` is undefined (add_clause
 *     requires it) or names unknown keys.
 *   • Returns the resolved facet ids — [] for the explicit "governs nothing" marker,
 *     or one id per named facet (de-duplicated).
 * The caller (sections.ts) decides whether a verdict is required: add_clause always
 * calls this (undefined → throw); edit_clause calls it only when a verdict is given.
 */
export async function validateClauseFacets(
  memexId: string,
  verdict: string[] | undefined,
): Promise<string[] | null> {
  const owner = await ownerForMemex(memexId);
  if (!owner) return null;
  const vocab = await db
    .select({ key: facets.key, name: facets.name, description: facets.description, ord: facets.ord, id: facets.id })
    .from(facets)
    .where(and(eq(facets.ownerType, owner.ownerType), eq(facets.ownerId, owner.ownerId)))
    .orderBy(asc(facets.ord));
  if (vocab.length === 0) return null;

  if (verdict === undefined) {
    throw new ValidationError(reHandClause(vocab, "add_clause requires a facet verdict."));
  }
  const idByKey = new Map(vocab.map((f) => [f.key, f.id]));
  const unknown = verdict.filter((k) => !idByKey.has(k));
  if (unknown.length > 0) {
    throw new ValidationError(reHandClause(vocab, `Unknown facet key(s): ${unknown.join(", ")}.`));
  }
  return [...new Set(verdict)].map((k) => idByKey.get(k)!);
}

/**
 * Bulk sibling of validateClauseFacets (spec-437 dec-1): validate MANY verdicts against
 * the owner's vocabulary with a SINGLE vocab load, returning the resolved facet ids per
 * verdict (or null-for-all when the Memex has no vocabulary). Used by the bulk authoring
 * path (addClausesToSection) so seeding / multi-clause sections don't re-query the vocab
 * once per clause — the per-clause query storm that regressed signup latency under load.
 * Same semantics as validateClauseFacets: an undefined verdict throws (required where a
 * vocabulary exists); unknown keys throw; [] resolves to [] (the governs-nothing marker).
 */
export interface ClauseFacetProblems {
  /** 1-based positions of clauses with no verdict at all. */
  missingVerdict: number[];
  /** 1-based position + the offending keys, per clause that named an unknown facet. */
  unknownKeys: { position: number; keys: string[] }[];
  /** The owner's vocabulary — empty when there is none (nothing to require). */
  vocab: OwnerFacet[];
  /** Resolved facet ids per clause. Meaningful only when there are no problems. */
  resolved: (string[] | null)[];
}

/**
 * spec-514 dec-2 — COLLECT every clause-level facet problem instead of throwing at the
 * first one, and tag each with the clause's **1-based position in the caller's array**.
 *
 * Two callers need different things from the same analysis, which is why this returns
 * rather than throws:
 *   • `validateClauseFacetsBatch` (below) throws on it — the standalone contract.
 *   • `validateClauseBatch` in clauses.ts merges these problems with its own empty-body
 *     findings into ONE message. That merge is not cosmetic: if the body check threw
 *     first, a batch with both kinds of fault would never report the verdict position, so
 *     the off-by-one it guards (ac-12) could not be observed at all.
 *
 * Positions are the caller's own indices because nothing is filtered before this runs.
 */
export async function collectClauseFacetProblems(
  memexId: string,
  verdicts: (string[] | undefined)[],
): Promise<ClauseFacetProblems> {
  const none: ClauseFacetProblems = {
    missingVerdict: [],
    unknownKeys: [],
    vocab: [],
    resolved: verdicts.map(() => null),
  };
  const owner = await ownerForMemex(memexId);
  if (!owner) return none;
  const vocab = await db
    .select({ key: facets.key, name: facets.name, description: facets.description, ord: facets.ord, id: facets.id })
    .from(facets)
    .where(and(eq(facets.ownerType, owner.ownerType), eq(facets.ownerId, owner.ownerId)))
    .orderBy(asc(facets.ord));
  if (vocab.length === 0) return none;

  const idByKey = new Map(vocab.map((f) => [f.key, f.id]));
  const missingVerdict: number[] = [];
  const unknownKeys: { position: number; keys: string[] }[] = [];
  const resolved: (string[] | null)[] = [];

  verdicts.forEach((verdict, i) => {
    const position = i + 1;
    if (verdict === undefined) {
      missingVerdict.push(position);
      resolved.push(null);
      return;
    }
    const unknown = verdict.filter((k) => !idByKey.has(k));
    if (unknown.length > 0) {
      unknownKeys.push({ position, keys: unknown });
      resolved.push(null);
      return;
    }
    resolved.push([...new Set(verdict)].map((k) => idByKey.get(k)!));
  });

  return { missingVerdict, unknownKeys, vocab, resolved };
}

/**
 * Render collected facet problems as sentences that each NAME the offending clause.
 * Every offender is reported, so one round trip tells the agent everything it got wrong
 * rather than forcing a retry per fault.
 */
export function facetProblemLines(problems: ClauseFacetProblems): string[] {
  const lines: string[] = [];
  const { missingVerdict, unknownKeys } = problems;
  if (missingVerdict.length === 1) {
    lines.push(`Clause ${missingVerdict[0]} has no facet verdict.`);
  } else if (missingVerdict.length > 1) {
    lines.push(`Clauses ${missingVerdict.join(", ")} have no facet verdict.`);
  }
  for (const { position, keys } of unknownKeys) {
    lines.push(`Clause ${position} names unknown facet key(s): ${keys.join(", ")}.`);
  }
  return lines;
}

export async function validateClauseFacetsBatch(
  memexId: string,
  verdicts: (string[] | undefined)[],
): Promise<(string[] | null)[]> {
  const problems = await collectClauseFacetProblems(memexId, verdicts);
  const lines = facetProblemLines(problems);
  if (lines.length > 0) {
    throw new ValidationError(reHandClause(problems.vocab, lines.join(" ")));
  }
  return problems.resolved;
}

/**
 * Persist a clause's facet verdict as standard_clause_facets rows (dec-2 tri-state):
 * replace any existing tags, then write one member row per facet id, OR a single
 * facet_id NULL marker for the explicit "governs nothing" verdict ([]). Routed through
 * mutate() emitting `clause` updated so the standard's pills refetch (dec-7 reverses
 * spec-340's inert-phase allowlist for the consume side).
 */
export async function persistClauseFacets(
  memexId: string,
  docId: string,
  clauseId: string,
  facetIds: string[],
  ctx: RequestCtx = {},
): Promise<void> {
  await mutate(ctx, { memexId, docId, entity: "clause", action: "updated" }, async () => {
    await db.delete(standardClauseFacets).where(eq(standardClauseFacets.clauseId, clauseId));
    if (facetIds.length === 0) {
      await db.insert(standardClauseFacets).values({ memexId, clauseId, facetId: null });
    } else {
      await db.insert(standardClauseFacets).values(facetIds.map((facetId) => ({ memexId, clauseId, facetId })));
    }
    return { id: clauseId };
  });
}

/**
 * Batch read: the facet KEYS for a set of clauses, keyed by clause id (spec-437 dec-4 —
 * the doc-view projection that drives the inline facet pills on the clause-coverage
 * shelf). The innerJoin to `facets` drops the facet_id NULL "governs nothing" markers, so
 * a deliberately-empty clause maps to [] (absent from the map → caller defaults to []).
 * Keys are sorted for stable display.
 */
export async function facetKeysByClause(
  memexId: string,
  clauseIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (clauseIds.length === 0) return out;
  const rows = await db
    .select({ clauseId: standardClauseFacets.clauseId, key: facets.key })
    .from(standardClauseFacets)
    .innerJoin(facets, eq(facets.id, standardClauseFacets.facetId))
    .where(
      and(eq(standardClauseFacets.memexId, memexId), inArray(standardClauseFacets.clauseId, clauseIds)),
    );
  for (const r of rows) {
    const arr = out.get(r.clauseId) ?? [];
    arr.push(r.key);
    out.set(r.clauseId, arr);
  }
  for (const [k, v] of out) out.set(k, v.sort());
  return out;
}
