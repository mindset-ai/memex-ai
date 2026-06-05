import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgMemberships, orgs, users } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { createShareToken } from "../services/share-tokens.js";

// Dev mode — sessionMiddleware auto-authenticates as dev@memex.ai. We seed the dev user
// as a member of account A only, then probe account B to prove isolation.
//
// t-18 of doc-15: subdomain-based tenant routing was retired in t-12. The same
// isolation guarantees now apply to the path-prefixed `/api/<ns>/<mx>/...`
// mounts, plus the flat entity-keyed routes that resolve memex via FK.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
});

const memexIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  if (memexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
  }
});

async function lookupOrgId(memexId: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId));
  if (!row?.orgId) throw new Error(`No org for memex ${memexId}`);
  return row.orgId;
}

async function setup() {
  const dev = await upsertUserByEmail("dev@memex.ai");
  userIds.push(dev.id);
  // Cross-test isolation: the dev user's membership list is global state. Wipe it so one
  // test's leftover doesn't skip another's check.
  await db.delete(orgMemberships).where(eq(orgMemberships.userId, dev.id));

  const accountA = await makeTestMemex("ca-a");
  const accountB = await makeTestMemex("ca-b");
  memexIds.push(accountA, accountB);

  // Namespace slug = the test prefix-NN; memex slug = "main" (makeTestMemex contract).
  const [{ slug: subA }] = await db
    .select({ slug: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, accountA));
  const [{ slug: subB }] = await db
    .select({ slug: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, accountB));

  const orgA = await lookupOrgId(accountA);
  await db.insert(orgMemberships).values({
    userId: dev.id,
    orgId: orgA,
    role: "administrator",
  });

  // Seed a doc in each account so we can try cross-tenant fetches.
  const docA = await createDocDraft(accountA, "Secret A", "private to A");
  const docB = await createDocDraft(accountB, "Secret B", "private to B");

  return { accountA, accountB, subA, subB, docA, docB };
}

// Build a path-prefixed URL for tenant A using the canonical apex host.
function tenantPath(namespaceSlug: string, suffix: string): string {
  return `/api/${namespaceSlug}/main${suffix}`;
}

describe("security: cross-account isolation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 when fetching a cross-tenant doc UUID via the path-prefixed mount (no info leak)", async () => {
    const { subA, docB } = await setup();

    // Hit account A's path prefix (where dev is admin) but ask for docB's UUID.
    // The path resolver attaches accountA; sessionMiddleware confirms membership;
    // getDoc filters by memexId so the cross-tenant doc 404s.
    const res = await app.request(tenantPath(subA, `/docs/${docB.id}`), {
      headers: { Host: "memex.ai" },
    });
    expect(res.status).toBe(404);
  });

  it("returns the correct tenant's doc on a handle collision (handles are per-memex)", async () => {
    const { subA } = await setup();
    // Both tenants have `spec-1` because handles are per-memex (createDocDraft
    // defaults to docType="spec" → spec-N, b-105). Asking for `spec-1` under
    // tenant A's path prefix must resolve tenant A's spec-1, not leak B's.
    // (The API fetch route is /docs/:id for every doc type — handle or UUID;
    // `/specs/` is the React-UI URL, not the API path.)
    const res = await app.request(tenantPath(subA, "/docs/spec-1"), {
      headers: { Host: "memex.ai" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Secret A");
    expect(body.title).not.toBe("Secret B");
  });

  it("share-token GET ignores a body memexId — account always comes from the token's doc", async () => {
    // Share tokens are public-path: no Authorization header, no session-account. The server
    // derives the account from the token → document → document.account_id. A caller cannot
    // escalate to a different tenant by forging a body field. The X-Memex-Account-Id
    // header is now ignored entirely (removed in t-12), so this is a regression guard.
    const { accountA, docA } = await setup();
    const tok = await createShareToken(accountA, docA.id);

    const forgedAccountId = "00000000-0000-4000-8000-000000000000";
    const res = await app.request(`/api/share/${tok.token}`, {
      method: "GET",
      headers: { "X-Memex-Account-Id": forgedAccountId, Host: "memex.ai" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The response carries the real doc's account, not the forged account id.
    expect(body.doc.memexId).toBe(accountA);
    expect(body.doc.memexId).not.toBe(forgedAccountId);
  });

  it("returns 410 when a share token is replayed against the share route after revocation", async () => {
    const { accountA, docA, subA } = await setup();
    const tok = await createShareToken(accountA, docA.id);

    // Healthy fetch works (public route — no Host gating on memex.ai needed but explicit).
    const ok = await app.request(`/api/share/${tok.token}`, { headers: { Host: "memex.ai" } });
    expect(ok.status).toBe(200);

    // Revoke via the path-prefixed share management endpoint (dev is admin of A).
    const revoke = await app.request(tenantPath(subA, `/docs/shares/${tok.id}`), {
      method: "DELETE",
      headers: { Host: "memex.ai" },
    });
    expect(revoke.status).toBe(200);

    // The same token now returns 410 Gone (not 200), closing the replay window.
    const replay = await app.request(`/api/share/${tok.token}`, { headers: { Host: "memex.ai" } });
    expect(replay.status).toBe(410);
  });

  it("cross-tenant doc list: hitting /api/<ns-B>/main/docs returns only tenant B's docs", async () => {
    // Grant dev membership on B as well, then probe B's docs list. It must
    // contain only B's doc, never A's — the index on memex_id plus the WHERE
    // clause in listDocs enforces the isolation.
    const { accountA, accountB, subB, docA, docB } = await setup();

    // Dev is already admin of A's org. Add dev to B's org so we can fetch B's docs.
    const dev = await upsertUserByEmail("dev@memex.ai");
    const orgB = await lookupOrgId(accountB);
    await db
      .insert(orgMemberships)
      .values({ userId: dev.id, orgId: orgB, role: "administrator" });

    const res = await app.request(tenantPath(subB, "/docs"), {
      headers: { Host: "memex.ai" },
    });
    expect(res.status).toBe(200);
    const list: Array<{ id: string; title: string; memexId: string }> = await res.json();
    const ids = list.map((d) => d.id);
    expect(ids).toContain(docB.id);
    expect(ids).not.toContain(docA.id);
    for (const d of list) expect(d.memexId).toBe(accountB);
    // accountA vs accountB — suppress unused-warning in readers reviewing this test.
    void accountA;
  });

  // Keep `orgs` referenced — future cross-account assertions will probe org-level state.
  void orgs;
});
