// spec-340 t-3 — the two make-or-break auto-seed paths: a freshly-created org and a
// freshly-created personal Memex each land with the 16 default facets, no manual step
// (ac-31). The suite-wide MEMEX_DEFAULT_FACETS_SEED=off gate (vitest.config.ts) is
// stubbed back ON here per the spec-178/184 sibling pattern (read at call time).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, users, namespaces, memexes } from "../db/schema.js";
import { DEFAULT_FACETS } from "../db/default-facets.fixture.js";
import { createOrgForUser } from "./orgs.js";
import { ensureUserNamespace } from "./user-namespaces.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const KEYS = new Set(DEFAULT_FACETS.map((f) => f.key));
const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function facetKeysFor(ownerType: "org" | "memex", ownerId: string): Promise<Set<string>> {
  const rows = await db
    .select({ key: facets.key })
    .from(facets)
    .where(and(eq(facets.ownerType, ownerType), eq(facets.ownerId, ownerId)));
  return new Set(rows.map((r) => r.key));
}

let savedGate: string | undefined;
const createdOrgIds: string[] = [];
const createdMemexIds: string[] = [];

beforeAll(() => {
  // Turn the auto-seed back ON for this suite (it is off suite-wide).
  savedGate = process.env.MEMEX_DEFAULT_FACETS_SEED;
  delete process.env.MEMEX_DEFAULT_FACETS_SEED;
});

afterAll(async () => {
  if (savedGate === undefined) delete process.env.MEMEX_DEFAULT_FACETS_SEED;
  else process.env.MEMEX_DEFAULT_FACETS_SEED = savedGate;
  for (const id of createdOrgIds) {
    await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, id))).catch(() => {});
  }
  for (const id of createdMemexIds) {
    await db.delete(facets).where(and(eq(facets.ownerType, "memex"), eq(facets.ownerId, id))).catch(() => {});
  }
});

describe("auto-seed the 16 facets on creation (spec-340 t-3, dec-7)", () => {
  it("creating a new org auto-seeds the 16 facets (owner_type='org') (ac-31)", async () => {
    tagAc(AC(31));
    const [user] = await db
      .insert(users)
      .values({ email: `${uniq("facorg")}@example.com`, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
      .returning();
    // The user needs a personal namespace first (mirrors the real signup→create-org flow).
    await ensureUserNamespace(user.id);

    const created = await createOrgForUser({ slug: uniq("facorg"), name: "Facet Org", userId: user.id });
    createdOrgIds.push(created.org.id);

    expect(await facetKeysFor("org", created.org.id)).toEqual(KEYS);
  });

  it("creating a new personal Memex auto-seeds the 16 facets (owner_type='memex') (ac-31)", async () => {
    tagAc(AC(31));
    const [user] = await db
      .insert(users)
      .values({ email: `${uniq("facmem")}@example.com`, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
      .returning();

    const { memex } = await ensureUserNamespace(user.id);
    createdMemexIds.push(memex.id);

    // The namespace is personal (kind='user'), so the owner is the memex itself.
    const [ns] = await db
      .select({ kind: namespaces.kind })
      .from(memexes)
      .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
      .where(eq(memexes.id, memex.id))
      .limit(1);
    expect(ns.kind).toBe("user");

    expect(await facetKeysFor("memex", memex.id)).toEqual(KEYS);
  });
});
