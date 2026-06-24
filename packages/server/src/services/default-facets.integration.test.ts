// spec-340 t-2 — the default-16 facet seed, and that it fires at org
// provisioning. DB-backed: idempotency and the per-org copy are enforced by the
// (org_id, key) constraint + the zero-row guard against a real Postgres.

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, namespaces, memexes, users } from "../db/schema.js";
import { seedDefaultFacets } from "./default-facets.js";
import { createOrgForUser } from "./orgs.js";
import { upsertUserByEmail } from "./users.js";
import { DEFAULT_FACETS } from "../db/default-facets.fixture.js";
import { makeTestMemex } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;
const rand = () => Math.random().toString(36).slice(2, 10);

async function orgIdFor(memexId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!row?.orgId) throw new Error("could not resolve org for test memex");
  return row.orgId;
}

let orgId: string;
let orgId2: string;

beforeAll(async () => {
  orgId = await orgIdFor(await makeTestMemex("fseed"));
  orgId2 = await orgIdFor(await makeTestMemex("fseed2"));
});

describe("seedDefaultFacets (spec-340 t-2)", () => {
  it("seeds the org its own copy of the 16 default facets, each with a required description (ac-1)", async () => {
    tagAc(AC(1));
    await seedDefaultFacets(orgId);
    const rows = await db.select().from(facets).where(eq(facets.orgId, orgId));

    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set(DEFAULT_FACETS.map((f) => f.key)));
    for (const r of rows) {
      // the REQUIRED classifier rubric — a real disambiguating sentence, not a stub
      expect(r.description).toBeTruthy();
      expect(r.description.length).toBeGreaterThan(40);
      expect(r.orgId).toBe(orgId);
    }
  });

  it("is idempotent — re-seeding leaves the 16 untouched (ac-26)", async () => {
    tagAc(AC(26));
    await seedDefaultFacets(orgId);
    await seedDefaultFacets(orgId);
    const rows = await db.select().from(facets).where(eq(facets.orgId, orgId));
    expect(rows).toHaveLength(16);
  });

  it("gives each org its own independent copy — no row shared across orgs (ac-26)", async () => {
    tagAc(AC(26));
    await seedDefaultFacets(orgId2);
    const a = await db.select().from(facets).where(eq(facets.orgId, orgId));
    const b = await db.select().from(facets).where(eq(facets.orgId, orgId2));
    expect(a).toHaveLength(16);
    expect(b).toHaveLength(16);
    const aIds = new Set(a.map((r) => r.id));
    const shared = b.filter((r) => aIds.has(r.id));
    expect(shared).toHaveLength(0);
  });
});

describe("seed fires at org provisioning (spec-340 t-2)", () => {
  it("createOrgForUser seeds the brand-new org's default vocabulary (ac-26)", async () => {
    tagAc(AC(26));
    const user = await upsertUserByEmail(`fac-${rand()}@example.com`);
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));

    const created = await createOrgForUser({ slug: `facw${rand()}`, userId: user.id });

    const rows = await db.select().from(facets).where(eq(facets.orgId, created.org.id));
    expect(rows).toHaveLength(16);
  });
});
