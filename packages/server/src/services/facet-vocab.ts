// spec-340 — facet vocabulary READ helpers (no LLM).
//
// Deliberately separated from facet-classifier.ts (the LLM engine) so the request
// path — the `facets` list tool (t-6) — can read the vocabulary WITHOUT importing the
// classifier. dec-8: no server request/write path may import the LLM classifier; the
// no-import guard (facet-classifier-no-request-path.regression.test.ts) bans the whole
// facet-classifier module from request-path dirs, so the vocabulary reads live here.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets } from "../db/schema.js";
import { ownerForMemex } from "./shared/memex-ownership.js";

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
