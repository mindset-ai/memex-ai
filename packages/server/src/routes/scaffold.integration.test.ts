// Integration tests for /api/orgs/:orgId/scaffold/* (b-68 t-10).
//
// Covers:
//   - ac-1  (SCOPE):  GET returns the BASE_SCAFFOLD + Org additions for an
//                     authorized member.
//   - ac-11 (IMPL):   no schema path to send `source` or `kind` in any write
//                     body — the table is the discriminator.
//   - ac-13 (IMPL):   RBAC + std-7 — admin writes succeed; members read but
//                     can't write; non-members 404 on both reads and writes.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

// Force per-user JWT-mode session middleware so each fixture carries its own
// identity — dev mode would resolve every request to dev@memex.ai.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import {
  namespaces,
  orgs,
  memexes,
  orgMemberships,
  orgScaffoldAdditions,
  users,
} from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/briefs/b-68/acs/ac-${n}`;

// ── Fixture plumbing ──────────────────────────────────────────────────────

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // Namespace cascade nukes org → memex → org_memberships → org_scaffold_additions.
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
});

async function seedUser(label: string): Promise<{
  userId: string;
  email: string;
  bearer: string;
}> {
  const email = `scaffold-${label}-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  createdUserIds.push(user.id);
  return { userId: user.id, email, bearer: signSessionToken(user.id) };
}

async function seedOrg(label: string): Promise<{
  orgId: string;
  namespaceId: string;
  memexId: string;
}> {
  const slug = `sc-${label}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  return db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "org" })
      .returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Scaffold ${label}` })
      .returning();
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [mx] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    createdNamespaceIds.push(ns.id);
    return { orgId: org.id, namespaceId: ns.id, memexId: mx.id };
  });
}

async function grant(
  userId: string,
  orgId: string,
  role: "member" | "administrator",
  status: "active" | "disabled" = "active",
): Promise<void> {
  await db
    .insert(orgMemberships)
    .values({ userId, orgId, role, status })
    .onConflictDoNothing();
}

async function authedRequest(
  path: string,
  init: RequestInit,
  bearer: string,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Host", "memex.ai");
  return app.request(path, { ...init, headers });
}

// ── ac-1: SCOPE — GET returns base + org-merged shape ────────────────────

describe("GET /api/orgs/:orgId/scaffold — merged base + org payload (ac-1)", () => {
  it("returns the BASE_SCAFFOLD plus the Org's additions for an authorized member", async () => {
    tagAc(AC(1));

    const owner = await seedUser("ac1-owner");
    const fx = await seedOrg("ac1");
    await grant(owner.userId, fx.orgId, "administrator");

    // Seed two org-additions directly so the route surfaces them in the `org` array.
    const [r1, r2] = await db
      .insert(orgScaffoldAdditions)
      .values([
        {
          orgId: fx.orgId,
          authorId: owner.userId,
          targetPhase: "specify",
          text: "Specify-phase org rule.",
          rationale: "Internal consistency.",
          enabled: true,
          displayOrder: 0,
        },
        {
          orgId: fx.orgId,
          authorId: owner.userId,
          targetTool: "create_task",
          text: "Tool-scoped org rule.",
          rationale: "Catch task drift.",
          enabled: false, // disabled rows MUST still surface to the UI
          displayOrder: 1,
        },
      ])
      .returning();

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold`,
      { method: "GET" },
      owner.bearer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      base: { phases: unknown[]; tools: unknown[]; baseGuidance: unknown[] };
      org: Array<{ id: string; source: string; enabled: boolean }>;
    };

    // base half: structurally the live BASE_SCAFFOLD dataset.
    expect(Array.isArray(body.base.phases)).toBe(true);
    expect(body.base.phases.length).toBeGreaterThan(0);
    expect(Array.isArray(body.base.tools)).toBe(true);
    expect(Array.isArray(body.base.baseGuidance)).toBe(true);

    // org half: both rows surface, disabled included, every entry source='org'.
    expect(body.org).toHaveLength(2);
    expect(body.org.map((b) => b.id).sort()).toEqual([r1.id, r2.id].sort());
    expect(body.org.every((b) => b.source === "org")).toBe(true);
    expect(body.org.some((b) => b.enabled === false)).toBe(true);
  });
});

// ── ac-13: RBAC + std-7 across read + write + non-member axes ────────────

describe("RBAC + std-7 — access paths (ac-13)", () => {
  it("administrator: read succeeds (200)", async () => {
    tagAc(AC(13));
    const admin = await seedUser("ac13-admin-read");
    const fx = await seedOrg("ac13-admin-read");
    await grant(admin.userId, fx.orgId, "administrator");

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold`,
      { method: "GET" },
      admin.bearer,
    );
    expect(res.status).toBe(200);
  });

  it("administrator: POST/PATCH/DELETE/toggle all succeed", async () => {
    tagAc(AC(13));
    const admin = await seedUser("ac13-admin-write");
    const fx = await seedOrg("ac13-admin-write");
    await grant(admin.userId, fx.orgId, "administrator");

    // POST
    const created = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions`,
      {
        method: "POST",
        body: JSON.stringify({
          target: { phase: "specify" },
          text: "Specify-phase: confirm scope ACs.",
          rationale: "Catches missing scope ACs.",
          enabled: true,
          order: 5,
        }),
      },
      admin.bearer,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; source: string };
    expect(typeof createdBody.id).toBe("string");
    expect(createdBody.source).toBe("org");

    // PATCH
    const patched = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${createdBody.id}`,
      { method: "PATCH", body: JSON.stringify({ text: "EDITED" }) },
      admin.bearer,
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { text: string };
    expect(patchedBody.text).toBe("EDITED");

    // toggle
    const toggled = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${createdBody.id}/toggle`,
      { method: "POST", body: JSON.stringify({ enabled: false }) },
      admin.bearer,
    );
    expect(toggled.status).toBe(200);
    const toggledBody = (await toggled.json()) as { enabled: boolean };
    expect(toggledBody.enabled).toBe(false);

    // DELETE
    const deleted = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${createdBody.id}`,
      { method: "DELETE" },
      admin.bearer,
    );
    expect(deleted.status).toBe(204);
  });

  it("ordinary member: read succeeds (200)", async () => {
    tagAc(AC(13));
    const member = await seedUser("ac13-member-read");
    const fx = await seedOrg("ac13-member-read");
    await grant(member.userId, fx.orgId, "member");

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold`,
      { method: "GET" },
      member.bearer,
    );
    expect(res.status).toBe(200);
  });

  it("ordinary member: POST/PATCH/DELETE/toggle all return 404 (no 403 leak per std-7)", async () => {
    tagAc(AC(13));
    const member = await seedUser("ac13-member-write");
    const fx = await seedOrg("ac13-member-write");
    await grant(member.userId, fx.orgId, "member");

    // Seed a real row via an admin so the PATCH/DELETE/toggle paths have a
    // legitimate id to target — proving the 404 isn't just "row not found".
    const admin = await seedUser("ac13-member-write-admin");
    await grant(admin.userId, fx.orgId, "administrator");
    const [seeded] = await db
      .insert(orgScaffoldAdditions)
      .values({
        orgId: fx.orgId,
        authorId: admin.userId,
        text: "Seeded.",
        rationale: "For member-write test.",
      })
      .returning();

    const post = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions`,
      {
        method: "POST",
        body: JSON.stringify({
          target: {},
          text: "should-be-blocked",
          rationale: "should-be-blocked",
        }),
      },
      member.bearer,
    );
    expect(post.status).toBe(404);

    const patch = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${seeded.id}`,
      { method: "PATCH", body: JSON.stringify({ text: "x" }) },
      member.bearer,
    );
    expect(patch.status).toBe(404);

    const del = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${seeded.id}`,
      { method: "DELETE" },
      member.bearer,
    );
    expect(del.status).toBe(404);

    const toggle = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${seeded.id}/toggle`,
      { method: "POST", body: JSON.stringify({ enabled: false }) },
      member.bearer,
    );
    expect(toggle.status).toBe(404);

    // The seeded row is still there — the member's PATCH/DELETE/toggle were
    // all genuine no-ops, not silent successes that 404'd on the response.
    const stillThere = await db.query.orgScaffoldAdditions.findFirst({
      where: eq(orgScaffoldAdditions.id, seeded.id),
    });
    expect(stillThere).toBeDefined();
    expect(stillThere?.text).toBe("Seeded.");
  });

  it("non-member: read returns 404 (std-7: no enumeration leak)", async () => {
    tagAc(AC(13));
    const stranger = await seedUser("ac13-non-read");
    const fx = await seedOrg("ac13-non-read");

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold`,
      { method: "GET" },
      stranger.bearer,
    );
    expect(res.status).toBe(404);
  });

  it("non-member: POST/PATCH/DELETE/toggle all return 404 (std-7: no enumeration leak)", async () => {
    tagAc(AC(13));
    const stranger = await seedUser("ac13-non-write");
    const fx = await seedOrg("ac13-non-write");

    // Seed a row via an admin so the write IDs exist and we're testing
    // membership-block, not row-missing.
    const admin = await seedUser("ac13-non-write-admin");
    await grant(admin.userId, fx.orgId, "administrator");
    const [seeded] = await db
      .insert(orgScaffoldAdditions)
      .values({
        orgId: fx.orgId,
        authorId: admin.userId,
        text: "Seeded.",
        rationale: "For non-member-write test.",
      })
      .returning();

    const post = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions`,
      {
        method: "POST",
        body: JSON.stringify({
          target: {},
          text: "should-be-blocked",
          rationale: "should-be-blocked",
        }),
      },
      stranger.bearer,
    );
    expect(post.status).toBe(404);

    const patch = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${seeded.id}`,
      { method: "PATCH", body: JSON.stringify({ text: "x" }) },
      stranger.bearer,
    );
    expect(patch.status).toBe(404);

    const del = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${seeded.id}`,
      { method: "DELETE" },
      stranger.bearer,
    );
    expect(del.status).toBe(404);

    const toggle = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${seeded.id}/toggle`,
      { method: "POST", body: JSON.stringify({ enabled: false }) },
      stranger.bearer,
    );
    expect(toggle.status).toBe(404);
  });

  it("disabled membership: read returns 404 (status='disabled' is treated as non-member)", async () => {
    tagAc(AC(13));
    const ex = await seedUser("ac13-disabled");
    const fx = await seedOrg("ac13-disabled");
    await grant(ex.userId, fx.orgId, "administrator", "disabled");

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold`,
      { method: "GET" },
      ex.bearer,
    );
    expect(res.status).toBe(404);
  });
});

// ── ac-11: dec-3 — no schema path to send `source` or `kind` ─────────────

describe("dec-3: no schema path to send `source` or `kind` (ac-11)", () => {
  it("POST with `source` in body is rejected (400) — extra keys never reach the service", async () => {
    tagAc(AC(11));
    const admin = await seedUser("ac11-post-source");
    const fx = await seedOrg("ac11-post-source");
    await grant(admin.userId, fx.orgId, "administrator");

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "base", // ← attempt to spoof base from the API surface
          target: {},
          text: "Should not write a base row.",
          rationale: "Should not write a base row.",
        }),
      },
      admin.bearer,
    );
    expect(res.status).toBe(400);

    // The on-disk row count for this org is unchanged — the rejected POST
    // didn't slip a row through with `source` silently stripped either.
    const rows = await db
      .select()
      .from(orgScaffoldAdditions)
      .where(eq(orgScaffoldAdditions.orgId, fx.orgId));
    expect(rows).toHaveLength(0);
  });

  it("POST with `kind` in body is rejected (400)", async () => {
    tagAc(AC(11));
    const admin = await seedUser("ac11-post-kind");
    const fx = await seedOrg("ac11-post-kind");
    await grant(admin.userId, fx.orgId, "administrator");

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions`,
      {
        method: "POST",
        body: JSON.stringify({
          kind: "phase",
          target: {},
          text: "Wrong kind attempt.",
          rationale: "Wrong kind attempt.",
        }),
      },
      admin.bearer,
    );
    expect(res.status).toBe(400);
  });

  it("PATCH with `source` in body is rejected (400) — the response surface stays source='org'", async () => {
    tagAc(AC(11));
    const admin = await seedUser("ac11-patch-source");
    const fx = await seedOrg("ac11-patch-source");
    await grant(admin.userId, fx.orgId, "administrator");

    const [seeded] = await db
      .insert(orgScaffoldAdditions)
      .values({
        orgId: fx.orgId,
        authorId: admin.userId,
        text: "Original",
        rationale: "Original rationale",
      })
      .returning();

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions/${seeded.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ source: "base", text: "Mutated" }),
      },
      admin.bearer,
    );
    expect(res.status).toBe(400);

    // Row is untouched — the rejected PATCH didn't sneak the text change through.
    const reloaded = await db.query.orgScaffoldAdditions.findFirst({
      where: eq(orgScaffoldAdditions.id, seeded.id),
    });
    expect(reloaded?.text).toBe("Original");
  });

  it("successful POST omits source/kind from the body; the response stamps source='org' from the table, kind='guidance_block' from code", async () => {
    tagAc(AC(11));
    const admin = await seedUser("ac11-shape");
    const fx = await seedOrg("ac11-shape");
    await grant(admin.userId, fx.orgId, "administrator");

    const res = await authedRequest(
      `/api/orgs/${fx.orgId}/scaffold/additions`,
      {
        method: "POST",
        body: JSON.stringify({
          target: { phase: "build" },
          text: "ok",
          rationale: "ok",
        }),
      },
      admin.bearer,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { source: string; kind: string };
    expect(body.source).toBe("org");
    expect(body.kind).toBe("guidance_block");

    // The on-disk row has neither column — the discriminator is the table.
    const row = await db.query.orgScaffoldAdditions.findFirst({
      where: eq(orgScaffoldAdditions.orgId, fx.orgId),
    });
    expect(row).toBeDefined();
    expect("source" in (row as object)).toBe(false);
    expect("kind" in (row as object)).toBe(false);
  });
});
