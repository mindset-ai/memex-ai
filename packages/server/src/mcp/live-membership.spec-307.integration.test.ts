// spec-307 — MCP access follows the user's LIVE membership, not the Org scope frozen
// into the token at consent (spec-31 dec-8, superseded). The single behavioural change
// is in app.ts: the /mcp OAuth branch sets `orgFilter = undefined`, so OAuth callers
// resolve against every CURRENT active membership exactly like PAT callers.
//
// These tests prove it end-to-end against the real /mcp endpoint, with an OAuth token
// minted PERSONAL-ONLY (orgId null) — the shape a user gets before they have any Org.
// The headline (ac-7): that same token, with no re-issue, reaches an Org the user joins
// AFTER the token was minted. The frozen `org` claim is inert (ac-8); a non-member Memex
// is still denied std-7-style (ac-6). True cross-tenant isolation is covered by
// tenant-isolation.regression.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, namespaces, orgs, memexes, orgMemberships } from "../db/schema.js";
import { signAccessToken, verifyAccessToken } from "../services/oauth/access-tokens.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-307/acs/ac-${n}`;

const originalOAuthEnabled = process.env.OAUTH_ENABLED;
beforeAll(() => {
  process.env.OAUTH_ENABLED = "1";
});
afterAll(() => {
  if (originalOAuthEnabled !== undefined) process.env.OAUTH_ENABLED = originalOAuthEnabled;
  else delete process.env.OAUTH_ENABLED;
});

const created = { users: [] as string[], namespaces: [] as string[] };
afterAll(async () => {
  // Namespaces cascade to memexes → docs; org_memberships cascade off the user/org.
  if (created.namespaces.length)
    await db.delete(namespaces).where(inArray(namespaces.id, created.namespaces)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

function uniq(p: string): string {
  return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toLowerCase().slice(0, 39);
}

async function makeUserWithPersonal(): Promise<{ userId: string; nsSlug: string; memexSlug: string }> {
  const tag = uniq("lm-u");
  const [u] = await db.insert(users).values({ email: `${tag}@memex.ai` } as never).returning();
  created.users.push(u.id);
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: tag, kind: "user", ownerUserId: u.id } as never)
    .returning();
  created.namespaces.push(ns.id);
  await db.insert(memexes).values({ name: "Personal", slug: "personal", namespaceId: ns.id } as never);
  return { userId: u.id, nsSlug: tag, memexSlug: "personal" };
}

async function makeOrgWithMemex(name: string): Promise<{ orgId: string; nsSlug: string; memexSlug: string }> {
  const tag = uniq(`lm-${name}`);
  const [ns] = await db.insert(namespaces).values({ slug: tag, kind: "org" } as never).returning();
  created.namespaces.push(ns.id);
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name } as never).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  await db.insert(memexes).values({ name, slug: "main", namespaceId: ns.id } as never);
  return { orgId: org.id, nsSlug: tag, memexSlug: "main" };
}

async function addMember(userId: string, orgId: string): Promise<void> {
  await db.insert(orgMemberships).values({ userId, orgId, role: "member" } as never);
}

async function mcpCall(token: string, toolName: string, args: unknown) {
  const { app } = await import("../app.js");
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`No SSE data: ${text}`);
  const body = JSON.parse(dataLine.slice(6)) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
  };
  return { status: res.status, isError: !!body.result?.isError, text: body.result?.content?.[0]?.text ?? "" };
}

// Fixture: user with a personal Memex. Token is minted PERSONAL-ONLY *before* any Org
// exists for them. Org-A membership is then added AFTER the token was issued (the
// graduation moment); Org-C is created with NO membership (the non-member control).
let user: { userId: string; nsSlug: string; memexSlug: string };
let personalOnlyToken: string;
let orgA: { orgId: string; nsSlug: string; memexSlug: string };
let orgC: { orgId: string; nsSlug: string; memexSlug: string };

beforeAll(async () => {
  user = await makeUserWithPersonal();

  // Minted while the user has ONLY their personal Memex — orgId null, the pre-Org shape.
  personalOnlyToken = signAccessToken({
    userId: user.userId,
    orgId: null,
    clientId: "spec-307-test-client",
    scopes: ["memex.full"],
  });

  // Graduation: the user gains Org-A AFTER the token was minted.
  orgA = await makeOrgWithMemex("orgA");
  await addMember(user.userId, orgA.orgId);

  // Non-member control: Org-C exists but the user is not a member.
  orgC = await makeOrgWithMemex("orgC");
});

describe("spec-307: MCP access follows live membership, not the frozen token scope", () => {
  it("ac-7: a personal-only token reaches an Org joined AFTER it was minted — no re-issue (graduation)", async () => {
    tagAc(AC(7));
    tagAc(AC(1)); // scope: connect once survives Org graduation, no re-auth/reconfig
    const r = await mcpCall(personalOnlyToken, "list_docs", { memex: `${orgA.nsSlug}/${orgA.memexSlug}` });
    expect(r.status).toBe(200);
    expect(r.isError, `personal-only token should reach Org-A gained after issuance: ${r.text}`).toBe(false);
  });

  it("ac-5: live membership — list_memexes returns the user's personal + Org memexes (not just personal)", async () => {
    tagAc(AC(5));
    const r = await mcpCall(personalOnlyToken, "list_memexes", {});
    expect(r.status).toBe(200);
    expect(r.isError, `list_memexes errored: ${r.text}`).toBe(false);
    // The old frozen-scope model (orgId null) would have returned ONLY the personal
    // Memex. Live membership includes Org-A.
    expect(r.text).toContain(`${orgA.nsSlug}/${orgA.memexSlug}`);
    expect(r.text).toContain(`${user.nsSlug}/${user.memexSlug}`);
  });

  it("ac-6: reaches a member Org's Memex and is denied a non-member Memex (std-7)", async () => {
    tagAc(AC(6));
    tagAc(AC(3)); // scope: reach exactly the owner's current memberships, never more
    const member = await mcpCall(personalOnlyToken, "list_docs", { memex: `${orgA.nsSlug}/${orgA.memexSlug}` });
    expect(member.isError, `member Org should be reachable: ${member.text}`).toBe(false);

    const nonMember = await mcpCall(personalOnlyToken, "list_docs", { memex: `${orgC.nsSlug}/${orgC.memexSlug}` });
    expect(nonMember.status).toBe(200);
    expect(nonMember.isError, "non-member Org-C must be denied").toBe(true);
    expect(nonMember.text.toLowerCase()).toMatch(/not a member|forbidden|permission|access|not found/);
  });

  it("ac-8: the existing token is untouched — its claims are intact (org=null) and it still works", async () => {
    tagAc(AC(8));
    tagAc(AC(2)); // scope: no existing connection is forced to reconnect/re-consent
    // No migration / re-mint: the token's stored scope claim is exactly as issued.
    const claims = verifyAccessToken(personalOnlyToken);
    expect(claims.org).toBeNull();
    expect(claims.sub).toBe(user.userId);
    // And it still validates + resolves at /mcp despite the frozen scope being ignored.
    const r = await mcpCall(personalOnlyToken, "list_memexes", {});
    expect(r.isError, `existing token should still work post-change: ${r.text}`).toBe(false);
  });
});
