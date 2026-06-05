import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";

// Session middleware now verifies our own HS256 JWT. AUTH_JWT_SECRET must land before
// app.ts transitively imports session.ts (module-scope secret capture).
const ORIGINAL_CLIENT_ID = vi.hoisted(() => {
  const v = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  return v;
});
const ORIGINAL_JWT_SECRET = vi.hoisted(() => {
  const v = process.env.AUTH_JWT_SECRET;
  process.env.AUTH_JWT_SECRET = "x".repeat(48);
  return v;
});

import { db } from "../db/connection.js";
import { memexes, namespaces, orgMemberships, orgs, users } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";

const memexIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.AUTH_JWT_SECRET = ORIGINAL_JWT_SECRET;
  if (memexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
  }
});

function bearer(userId: string): { Authorization: string } {
  return { Authorization: `Bearer ${signSessionToken(userId)}` };
}

describe("security: authentication", () => {
  // t-18 of doc-15: Hosts other than the apex are 404'd (subdomain routing
  // retired in t-12), and `/api/account` was removed in t-16. Tenancy-scoped
  // endpoints now mount at `/api/<namespace>/<memex>/<resource>`. We probe
  // GET /api/<ns>/<mx>/docs as the canonical session-gated tenant endpoint
  // because:
  //   - memexResolver populates ctx.memex from the path prefix
  //   - sessionMiddleware verifies the user is a member of that memex
  //   - It's the most direct way to exercise the whole auth stack
  //
  // std-7 contract: non-member callers and unknown namespaces both return 404,
  // not 403. The disabled-user case is the one place 403 is still expected
  // because the session layer fails-fast before the membership check.
  //
  // spec-111 t-10: GET /docs is now a PUBLIC-READ route behind the permissive
  // session layer. The probe memex below is PRIVATE (default visibility), so an
  // anonymous OR invalid-token caller no longer 401s — they degrade to anonymous
  // and the read gate returns a std-7 404 (indistinguishable from non-existent;
  // no enumeration leak). The auth-rejection-as-401 behaviour still holds for
  // the STRICT write/session routes (exercised elsewhere) — this read route just
  // resolves the unauthenticated caller to "anonymous" rather than rejecting it.

  let tenantHost: string;
  let namespaceSlug: string;
  let memexSlug: string;
  let tenantAccountId: string;
  let tenantOrgId: string;

  beforeAll(async () => {
    tenantAccountId = await makeTestMemex("sec-a");
    memexIds.push(tenantAccountId);
    // doc-15 t-11: subdomain → namespace.slug (memexes have a `slug` for the path
    // segment). After t-12 the apex memex.ai is the only valid host; the
    // (namespace, memex) pair now lives in the URL path.
    const acct = await db.query.memexes.findFirst({ where: eq(memexes.id, tenantAccountId) });
    memexSlug = acct!.slug;
    const ns = await db.query.namespaces.findFirst({
      where: eq(namespaces.id, acct!.namespaceId),
    });
    namespaceSlug = ns!.slug;
    tenantOrgId = ns!.ownerOrgId!;
    tenantHost = "memex.ai";
  });

  function tenantUrl(suffix = ""): string {
    return `/api/${namespaceSlug}/${memexSlug}/docs${suffix}`;
  }

  // spec-111 t-10: anonymous read of a PRIVATE memex → std-7 404 (not 401). The
  // permissive read layer resolves "no token" to anonymous; the read gate then
  // 404s the private memex, indistinguishable from non-existent.
  it("returns 404 (std-7) when Authorization header is missing on a private-memex read route", async () => {
    const res = await app.request(tenantUrl(), { headers: { Host: tenantHost } });
    expect(res.status).toBe(404);
  });

  // An invalid token is treated as anonymous on the permissive read path, so a
  // private memex returns std-7 404 rather than the strict-path 401.
  it("returns 404 (std-7) when the bearer token fails signature verification on a private-memex read route", async () => {
    const res = await app.request(tenantUrl(), {
      headers: { Host: tenantHost, Authorization: "Bearer not.a.valid.jwt" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 (std-7) when a JWT's sub doesn't resolve to a user on a private-memex read route", async () => {
    const res = await app.request(tenantUrl(), {
      headers: { Host: tenantHost, ...bearer("00000000-0000-0000-0000-000000000000") },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when a valid token resolves to a disabled user", async () => {
    const disabled = await upsertUserByEmail("disabled-sec@example.com");
    userIds.push(disabled.id);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, disabled.id));

    const res = await app.request(tenantUrl(), {
      headers: { Host: tenantHost, ...bearer(disabled.id) },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the user is active but not a member of the tenant (std-7)", async () => {
    // std-7: don't distinguish "doesn't exist" from "can't see it" — both 404.
    const outsider = await upsertUserByEmail("outsider-sec@example.com");
    userIds.push(outsider.id);

    const res = await app.request(tenantUrl(), {
      headers: { Host: tenantHost, ...bearer(outsider.id) },
    });
    expect(res.status).toBe(404);
  });

  it("active member can hit a session-gated tenant endpoint", async () => {
    // Positive case: ensure the path-prefixed mount + sessionMiddleware
    // membership check both succeed for a real member. Replaces the prior
    // "admin-only route" probe (the legacy /api/account endpoint that used to
    // gate on role=administrator is gone — admin-only operations now live on
    // /api/orgs/*, which is caller-scoped, not tenancy-scoped).
    const member = await upsertUserByEmail("member-sec@example.com");
    userIds.push(member.id);
    await db
      .insert(orgMemberships)
      .values({ userId: member.id, orgId: tenantOrgId, role: "member" })
      .onConflictDoNothing();

    const res = await app.request(tenantUrl(), {
      headers: { Host: tenantHost, ...bearer(member.id) },
    });
    expect(res.status).toBe(200);
  });

  it("treats an expired token as anonymous → std-7 404 on a private-memex read route", async () => {
    // Mint a token that's already past its exp. On the permissive read path an
    // expired token resolves to anonymous (not a hard 401), so a private memex
    // returns the std-7 404.
    const member = await upsertUserByEmail("expired-sec@example.com");
    userIds.push(member.id);
    const expired = signSessionToken(member.id, -60);

    const res = await app.request(tenantUrl(), {
      headers: { Host: tenantHost, Authorization: `Bearer ${expired}` },
    });
    expect(res.status).toBe(404);
  });

  // spec-111 t-10 guard: WRITES stay strict. The permissive layer is read-only;
  // any mutating verb on the same tenant surface must still hard-401 an
  // anonymous caller (never degrade to anonymous-then-404, and never reach the
  // handler). This locks in that the per-verb split didn't loosen writes.
  it("returns 401 on an anonymous WRITE (POST) to a tenant route", async () => {
    const res = await app.request(`${tenantUrl()}/some-doc-id/archive`, {
      method: "POST",
      headers: { Host: tenantHost },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid-token WRITE (POST) with 401", async () => {
    const res = await app.request(`${tenantUrl()}/some-doc-id/archive`, {
      method: "POST",
      headers: { Host: tenantHost, Authorization: "Bearer not.a.valid.jwt" },
    });
    expect(res.status).toBe(401);
  });

  // Keep `orgs` referenced so the import isn't pruned by tsc-strict; future
  // assertions may probe org-level state here.
  void orgs;
});
