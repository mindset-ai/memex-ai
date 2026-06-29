// spec-340 — facet vocabulary READ helpers (no LLM).
//
// Deliberately separated from facet-classifier.ts (the LLM engine) so the request
// path — the `facets` list tool (t-6) — can read the vocabulary WITHOUT importing the
// classifier. dec-8: no server request/write path may import the LLM classifier; the
// no-import guard (facet-classifier-no-request-path.regression.test.ts) bans the whole
// facet-classifier module from request-path dirs, so the vocabulary reads live here.

import { and, asc, eq } from "drizzle-orm";
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

function reHandClause(vocab: OwnerFacet[], lead: string): string {
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
