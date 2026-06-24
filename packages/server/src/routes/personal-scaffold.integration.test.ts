// Integration tests for /api/:namespace/:memex/scaffold/* — the PERSONAL
// namespace scaffold surface (spec-360 follow-up).
//
// The owner of a personal namespace is the admin of their own workspace: they
// get the full add/edit/disable/delete/toggle surface, owned by the namespace.
//
// Covers:
//   - personal owner CRUD (create/list/update/toggle/delete) round-trips.
//   - std-7 isolation: a non-owner (stranger) gets 404 on every verb; the
//     owner of namespace A can't touch namespace B's rows (cross-tenant guard).
//   - org rows and personal rows never leak into one another's reads.
//
// Tagged to spec-360 ac-2 (add/edit/disable/delete lifecycle), ac-3 (server-side
// gate, no existence leak), ac-8 (full lifecycle routing to scaffold-additions).

import { describe, it, expect, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

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
  users,
} from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

// ── Fixture plumbing ──────────────────────────────────────────────────────

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
});

interface PersonalFixture {
  userId: string;
  bearer: string;
  namespaceId: string;
  namespaceSlug: string;
  memexId: string;
  memexSlug: string;
}

async function seedPersonal(label: string): Promise<PersonalFixture> {
  const email = `pscaffold-${label}-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(user.id);
  const { namespace, memex } = await ensureUserNamespace(user.id);
  createdNamespaceIds.push(namespace.id);
  return {
    userId: user.id,
    bearer: signSessionToken(user.id),
    namespaceId: namespace.id,
    namespaceSlug: namespace.slug,
    memexId: memex.id,
    memexSlug: memex.slug,
  };
}

async function seedOrgWithAdmin(label: string): Promise<{
  bearer: string;
  orgId: string;
  namespaceSlug: string;
  memexSlug: string;
}> {
  const email = `pscaffold-org-${label}-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(user.id);
  await ensureUserNamespace(user.id);

  const slug = `psc-${label}-${Date.now().toString(36)}`.toLowerCase().slice(0, 39);
  const fx = await db.transaction(async (tx) => {
    const [ns] = await tx.insert(namespaces).values({ slug, kind: "org" }).returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `PScaffold ${label}` })
      .returning();
    await tx.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    const [mx] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    createdNamespaceIds.push(ns.id);
    return { orgId: org.id, namespaceSlug: ns.slug, memexSlug: mx.slug };
  });
  await db.insert(orgMemberships).values({
    userId: user.id,
    orgId: fx.orgId,
    role: "administrator",
    status: "active",
  });
  return { bearer: signSessionToken(user.id), ...fx };
}

async function req(
  path: string,
  init: RequestInit,
  bearer?: string,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Host", "memex.ai");
  return app.request(path, { ...init, headers });
}

function scaffoldPath(fx: { namespaceSlug: string; memexSlug: string }): string {
  return `/api/${fx.namespaceSlug}/${fx.memexSlug}/scaffold`;
}

// ── Owner CRUD round-trip ──────────────────────────────────────────────────

describe("personal scaffold — owner CRUD (ac-2 / ac-8)", () => {
  it("owner can create, list, update, toggle and delete their own additions", async () => {
    tagAc(AC(2));
    tagAc(AC(8));
    const fx = await seedPersonal("crud");
    const base = scaffoldPath(fx);

    // GET — merged payload, empty additions to start.
    const getEmpty = await req(base, { method: "GET" }, fx.bearer);
    expect(getEmpty.status).toBe(200);
    const emptyBody = (await getEmpty.json()) as { base: unknown; org: unknown[] };
    expect(emptyBody.base).toBeDefined();
    expect(emptyBody.org).toEqual([]);

    // POST — create an addition.
    const postRes = await req(
      `${base}/additions`,
      {
        method: "POST",
        body: JSON.stringify({
          target: { phase: "specify" },
          text: "Personal specify rule.",
          rationale: "My own house style.",
        }),
      },
      fx.bearer,
    );
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as {
      id: string;
      source: string;
      kind: string;
      enabled: boolean;
      namespaceId?: string;
      orgId?: string;
    };
    expect(created.source).toBe("org");
    expect(created.kind).toBe("guidance_block");
    expect(created.namespaceId).toBe(fx.namespaceId);
    expect(created.orgId).toBeUndefined();

    // GET — the row surfaces.
    const getOne = await req(base, { method: "GET" }, fx.bearer);
    const oneBody = (await getOne.json()) as { org: { id: string; text: string }[] };
    expect(oneBody.org).toHaveLength(1);
    expect(oneBody.org[0].text).toBe("Personal specify rule.");

    // PATCH — edit the text.
    const patchRes = await req(
      `${base}/additions/${created.id}`,
      { method: "PATCH", body: JSON.stringify({ text: "Edited personal rule." }) },
      fx.bearer,
    );
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { text: string }).text).toBe("Edited personal rule.");

    // toggle — disable.
    const toggleRes = await req(
      `${base}/additions/${created.id}/toggle`,
      { method: "POST", body: JSON.stringify({ enabled: false }) },
      fx.bearer,
    );
    expect(toggleRes.status).toBe(200);
    expect(((await toggleRes.json()) as { enabled: boolean }).enabled).toBe(false);

    // DELETE — remove it.
    const delRes = await req(
      `${base}/additions/${created.id}`,
      { method: "DELETE" },
      fx.bearer,
    );
    expect(delRes.status).toBe(204);
    const getGone = await req(base, { method: "GET" }, fx.bearer);
    expect(((await getGone.json()) as { org: unknown[] }).org).toEqual([]);
  });

  it("rejects source/kind in the write body (the table is the discriminator)", async () => {
    tagAc(AC(8));
    const fx = await seedPersonal("disc");
    const base = scaffoldPath(fx);
    const res = await req(
      `${base}/additions`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "base",
          target: { phase: "build" },
          text: "x",
          rationale: "y",
        }),
      },
      fx.bearer,
    );
    expect(res.status).toBe(400);
  });
});

// ── std-7 isolation ────────────────────────────────────────────────────────

describe("personal scaffold — std-7 isolation (ac-3)", () => {
  it("a non-owner gets 404 on read and every write verb (no existence leak)", async () => {
    tagAc(AC(3));
    const owner = await seedPersonal("iso-owner");
    const stranger = await seedPersonal("iso-stranger");
    const base = scaffoldPath(owner);

    // Owner seeds a row.
    const created = await req(
      `${base}/additions`,
      {
        method: "POST",
        body: JSON.stringify({ target: {}, text: "Owner only.", rationale: "Mine." }),
      },
      owner.bearer,
    );
    const { id } = (await created.json()) as { id: string };

    // Stranger — every verb 404s against the owner's namespace path.
    expect((await req(base, { method: "GET" }, stranger.bearer)).status).toBe(404);
    expect(
      (
        await req(
          `${base}/additions`,
          { method: "POST", body: JSON.stringify({ target: {}, text: "x", rationale: "y" }) },
          stranger.bearer,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await req(
          `${base}/additions/${id}`,
          { method: "PATCH", body: JSON.stringify({ text: "hijack" }) },
          stranger.bearer,
        )
      ).status,
    ).toBe(404);
    expect(
      (await req(`${base}/additions/${id}`, { method: "DELETE" }, stranger.bearer)).status,
    ).toBe(404);

    // Anonymous → 401 (strict session) before the owner gate.
    expect((await req(base, { method: "GET" })).status).toBe(401);

    // The owner's row is untouched.
    const stillThere = await req(base, { method: "GET" }, owner.bearer);
    expect(((await stillThere.json()) as { org: unknown[] }).org).toHaveLength(1);
  });

  it("owner of namespace A cannot touch namespace B's row even by id", async () => {
    tagAc(AC(3));
    const a = await seedPersonal("xa");
    const b = await seedPersonal("xb");

    // B creates a row.
    const created = await req(
      `${scaffoldPath(b)}/additions`,
      { method: "POST", body: JSON.stringify({ target: {}, text: "B's row.", rationale: "B." }) },
      b.bearer,
    );
    const { id } = (await created.json()) as { id: string };

    // A PATCHes B's id under A's OWN path — cross-tenant guard → 404.
    const patch = await req(
      `${scaffoldPath(a)}/additions/${id}`,
      { method: "PATCH", body: JSON.stringify({ text: "stolen" }) },
      a.bearer,
    );
    expect(patch.status).toBe(404);

    // B's row is unchanged.
    const bList = await req(scaffoldPath(b), { method: "GET" }, b.bearer);
    expect(((await bList.json()) as { org: { text: string }[] }).org[0].text).toBe("B's row.");
  });
});

// ── org ↔ personal never leak ──────────────────────────────────────────────

describe("personal scaffold — org and personal rows never leak (ac-3)", () => {
  it("a personal owner's GET excludes org-owned rows and vice versa", async () => {
    tagAc(AC(3));
    const personal = await seedPersonal("leak-p");
    const org = await seedOrgWithAdmin("leak-o");

    // Personal owner creates a personal row.
    await req(
      `${scaffoldPath(personal)}/additions`,
      { method: "POST", body: JSON.stringify({ target: {}, text: "Personal.", rationale: "p." }) },
      personal.bearer,
    );
    // Org admin creates an org row (via the org route).
    await req(
      `/api/orgs/${org.orgId}/scaffold/additions`,
      { method: "POST", body: JSON.stringify({ target: {}, text: "Org.", rationale: "o." }) },
      org.bearer,
    );

    // Personal GET sees ONLY the personal row.
    const pGet = await req(scaffoldPath(personal), { method: "GET" }, personal.bearer);
    const pBody = (await pGet.json()) as { org: { text: string; namespaceId?: string }[] };
    expect(pBody.org).toHaveLength(1);
    expect(pBody.org[0].text).toBe("Personal.");

    // Org GET sees ONLY the org row.
    const oGet = await req(`/api/orgs/${org.orgId}/scaffold`, { method: "GET" }, org.bearer);
    const oBody = (await oGet.json()) as { org: { text: string }[] };
    expect(oBody.org).toHaveLength(1);
    expect(oBody.org[0].text).toBe("Org.");
  });
});
