// spec-567 issue-1 → t-11 (ac-20) — the facet vocabulary reaches the ballot in ONE order.
//
// `vocabForMemex` had no ORDER BY, so Postgres returned the owner's facets in whatever
// order the plan produced (heap order, or the owner/key index order). `trueFacetsOf`
// derives a ballot's TRUE keys by walking that vocabulary, so two identical ballots could
// be stored in `facet_routing_log.facet_keys` in different orders — which made every
// "same ballot" comparison over the log (the dec-2 repeat-rate reads) order-sensitive.
//
// The fixture is built so neither accidental order can pass: facets are INSERTED in an
// order that is neither `ord` nor key order, and two of them TIE on `ord` (the column
// defaults to 0, so a tie is the common case, not the edge) — the tie must resolve by key.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, orgs, memexes, facets } from "../db/schema.js";
import { vocabForMemex } from "./facet-vocab.js";
import { trueFacetsOf } from "./facet-ballot.js";

const AC_20 = "mindset-prod/memex-building-itself/specs/spec-567/acs/ac-20";

// std-37: per-worker-unique identifiers so parallel workers never collide.
const uniq = `x567v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();

let memexId: string;
let orgId: string;

// Inserted in THIS order. Key order would be a,b,c,d; insertion order is a,d,c,b.
const FIXTURE = [
  { key: "a", ord: 2 },
  { key: "d", ord: 1 },
  { key: "c", ord: 0 },
  { key: "b", ord: 0 }, // ties with c on ord → key breaks the tie: b before c
] as const;
const EXPECTED = ["b", "c", "d", "a"];

beforeAll(async () => {
  const [ns] = await db.insert(namespaces).values({ slug: uniq, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${uniq}` }).returning();
  orgId = org.id;
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  memexId = mx.id;
  for (const f of FIXTURE) {
    await db.insert(facets).values({ ownerType: "org", ownerId: org.id, key: f.key, description: f.key, ord: f.ord });
  }
});

afterAll(async () => {
  await db.delete(facets).where(eq(facets.ownerId, orgId)).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
});

describe("spec-567 t-11 — vocabForMemex has a total order", () => {
  it("returns the vocabulary ordered by ord, ties broken by key", async () => {
    tagAc(AC_20);
    const vocab = await vocabForMemex(memexId);
    expect(vocab.map((f) => f.key)).toEqual(EXPECTED);
  });

  it("an identical ballot yields its TRUE keys in the same order on every read", async () => {
    tagAc(AC_20);
    const ballot = { verdict: { a: true, b: true, c: true, d: true }, none: false };
    const first = trueFacetsOf(ballot, await vocabForMemex(memexId));
    const second = trueFacetsOf(ballot, await vocabForMemex(memexId));
    expect(first).toEqual(EXPECTED);
    expect(second).toEqual(first);
  });
});
