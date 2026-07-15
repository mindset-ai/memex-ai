// spec-482 t-2 — the MCP-connection signal against the real DB. Mirrors the
// activation-cohort integration test's setup (unique users, seed usage_events,
// clean up in afterEach). The signal is a HISTORICAL, MONOTONIC fact derived
// from `mcp.tool_called` usage_events — never a self-reported flag:
//   ac-9  — false with no events; true after an mcp.tool_called event is seeded.
//   ac-10 — once true, stays true (monotonic; never reverts).
// Plus: the org variant is scoped correctly — a different org's traffic does NOT
// flip it true (usage_events is RLS-excluded, so the query filters explicitly on
// the org's member user IDs).
import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { namespaces, orgMemberships, orgs, usageEvents, users } from "../db/schema.js";
import { hasEverUsedMcp, orgHasEverUsedMcp } from "./mcp-connection.js";

const AC9 = "mindset-prod/memex-building-itself/specs/spec-482/acs/ac-9";
const AC10 = "mindset-prod/memex-building-itself/specs/spec-482/acs/ac-10";

const rand = () => Math.random().toString(36).slice(2, 8);
let slugSeq = 0;
const uniqueSlug = (p: string) => `${p}-${Date.now().toString(36)}-${(slugSeq += 1)}-${rand()}`.toLowerCase().slice(0, 39);

const createdUsers: string[] = [];
const createdOrgs: string[] = [];
const createdNamespaces: string[] = [];

async function seedUser(prefix: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `spec482-t2-${prefix}-${rand()}@example.test` })
    .returning({ id: users.id });
  createdUsers.push(u!.id);
  return u!.id;
}

async function seedOrg(prefix: string, memberIds: string[]): Promise<string> {
  const slug = uniqueSlug(prefix);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  createdNamespaces.push(ns!.id);
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns!.id, name: `Test ${prefix}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);
  await db.update(namespaces).set({ ownerOrgId: org!.id }).where(eq(namespaces.id, ns!.id));
  if (memberIds.length) {
    await db
      .insert(orgMemberships)
      .values(memberIds.map((userId) => ({ userId, orgId: org!.id, role: "member" })))
      .onConflictDoNothing();
  }
  return org!.id;
}

async function seedToolCalled(userId: string): Promise<void> {
  await db
    .insert(usageEvents)
    .values({ actorUserId: userId, name: "mcp.tool_called", source: "backend", env: "test" });
}

afterEach(async () => {
  if (createdUsers.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.actorUserId, createdUsers)).catch(() => {});
  }
  if (createdOrgs.length) {
    await db.delete(orgMemberships).where(inArray(orgMemberships.orgId, createdOrgs)).catch(() => {});
    await db.delete(orgs).where(inArray(orgs.id, createdOrgs)).catch(() => {});
  }
  if (createdNamespaces.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaces)).catch(() => {});
  }
  if (createdUsers.length) {
    await db.delete(users).where(inArray(users.id, createdUsers)).catch(() => {});
  }
  createdUsers.length = 0;
  createdOrgs.length = 0;
  createdNamespaces.length = 0;
});

describe("mcp-connection signal (spec-482 t-2)", () => {
  it("hasEverUsedMcp is false with no events, true after an mcp.tool_called (ac-9)", async () => {
    tagAc(AC9);
    const userId = await seedUser("user");

    expect(await hasEverUsedMcp(userId)).toBe(false);

    await seedToolCalled(userId);
    expect(await hasEverUsedMcp(userId)).toBe(true);
  });

  it("other usage events (e.g. mcp.connected) do NOT flip the signal — only mcp.tool_called counts (ac-9)", async () => {
    tagAc(AC9);
    const userId = await seedUser("connected-only");
    await db
      .insert(usageEvents)
      .values({ actorUserId: userId, name: "mcp.connected", source: "backend", env: "test" });

    expect(await hasEverUsedMcp(userId)).toBe(false);
  });

  it("once true, stays true — monotonic, never reverts (ac-10)", async () => {
    tagAc(AC10);
    const userId = await seedUser("monotonic");

    await seedToolCalled(userId);
    expect(await hasEverUsedMcp(userId)).toBe(true);

    // More tool calls only reinforce it; there is no path that clears the signal.
    await seedToolCalled(userId);
    await seedToolCalled(userId);
    expect(await hasEverUsedMcp(userId)).toBe(true);
  });

  it("org variant: true iff a member has produced MCP traffic (ac-9)", async () => {
    tagAc(AC9);
    const member = await seedUser("org-member");
    const orgId = await seedOrg("org", [member]);

    expect(await orgHasEverUsedMcp(orgId)).toBe(false);

    await seedToolCalled(member);
    expect(await orgHasEverUsedMcp(orgId)).toBe(true);
  });

  it("org variant is scoped: a DIFFERENT org's traffic does NOT flip it true (ac-9)", async () => {
    tagAc(AC9);
    const memberA = await seedUser("orgA-member");
    const memberB = await seedUser("orgB-member");
    const orgA = await seedOrg("orgA", [memberA]);
    const orgB = await seedOrg("orgB", [memberB]);

    // Only org B's member produces traffic.
    await seedToolCalled(memberB);

    expect(await orgHasEverUsedMcp(orgB)).toBe(true);
    // org A must stay false — no cross-tenant leak from B's usage_events.
    expect(await orgHasEverUsedMcp(orgA)).toBe(false);
  });
});
