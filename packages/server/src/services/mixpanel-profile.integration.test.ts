// Integration tests for the /engage profile slice (spec-297 dec-7) — REAL Postgres,
// a fake ProfileSink (no network). Proves org-link resolution, the per-user sync,
// and the all-users backfill.

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, orgs, orgMemberships } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import {
  type EngageProfile,
  type ProfileSink,
  getUserOrgIds,
  syncUserProfile,
  backfillAllUserProfiles,
} from "./mixpanel-profile.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-297/acs";

class FakeProfileSink implements ProfileSink {
  readonly name = "fake-profile";
  readonly received: EngageProfile[] = [];
  async setProfiles(profiles: readonly EngageProfile[]): Promise<void> {
    this.received.push(...profiles);
  }
}

async function makeOrg(slugPrefix: string): Promise<string> {
  const slug = `${slugPrefix}-${Date.now()}-${Math.floor(performance.now())}`;
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Test Org" }).returning();
  // Set the namespace owner so it honours the owner-XOR invariant (an org
  // namespace must have owner_org_id set) — mirrors makeTestMemexWithDevAdmin.
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  return org.id;
}

let orgUserId: string;
let orgId: string;

beforeAll(async () => {
  // Use an excluded test domain (@example.com) so this namespace-less test user
  // never trips the migration-smoke "every active user has a namespace" invariant.
  // The mindset.ai internal-user-filter case is covered by the unit test.
  const u = await upsertUserByEmail(`proforg-${Date.now()}@example.com`);
  orgUserId = u.id;
  orgId = await makeOrg("proforg");
  await db
    .insert(orgMemberships)
    .values({ userId: orgUserId, orgId, role: "administrator" })
    .onConflictDoNothing();
});

describe("getUserOrgIds — opaque active-org links (ac-24)", () => {
  it("returns the user's active org ids", async () => {
    tagAc(`${AC}/ac-24`);
    const ids = await getUserOrgIds(orgUserId);
    expect(ids).toContain(orgId);
  });

  it("returns [] for a personal-only user", async () => {
    tagAc(`${AC}/ac-24`);
    const u = await upsertUserByEmail(`personal-${Date.now()}@example.com`);
    expect(await getUserOrgIds(u.id)).toEqual([]);
  });
});

describe("syncUserProfile — sends email_domain + org links (ac-23, ac-24, ac-8, ac-9)", () => {
  it("builds and sends the profile for a user with an org", async () => {
    tagAc(`${AC}/ac-23`);
    tagAc(`${AC}/ac-24`);
    tagAc(`${AC}/ac-8`); // email_domain is the internal-user filter
    tagAc(`${AC}/ac-9`); // org links enable per-org cohorting
    const sink = new FakeProfileSink();
    const payload = await syncUserProfile(orgUserId, { sink });
    expect(payload).not.toBeNull();
    expect(payload?.$distinct_id).toBe(orgUserId);
    expect(payload?.$set.email_domain).toBe("example.com");
    expect(payload?.$set.org_ids).toContain(orgId);
    expect(sink.received).toHaveLength(1);
  });

  it("is a no-op (returns null) when no sink is configured (self-hosted)", async () => {
    tagAc(`${AC}/ac-23`);
    const payload = await syncUserProfile(orgUserId, { sink: null });
    expect(payload).toBeNull();
  });
});

describe("backfillAllUserProfiles — one profile per existing user (ac-25, ac-9)", () => {
  it("sends a profile for every user, including our org user", async () => {
    tagAc(`${AC}/ac-25`);
    tagAc(`${AC}/ac-9`);
    const sink = new FakeProfileSink();
    const { total, sent } = await backfillAllUserProfiles({ sink });
    expect(total).toBeGreaterThan(0);
    expect(sent).toBe(total); // every user got a profile sent
    const mine = sink.received.find((p) => p.$distinct_id === orgUserId);
    expect(mine, "backfill must cover the pre-existing org user").toBeDefined();
    expect(mine?.$set.org_ids).toContain(orgId);
  });

  it("is a no-op when no sink is configured (self-hosted)", async () => {
    tagAc(`${AC}/ac-25`);
    expect(await backfillAllUserProfiles({ sink: null })).toEqual({ total: 0, sent: 0 });
  });
});
