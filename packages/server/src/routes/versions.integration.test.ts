// spec-448 t-6 — HTTP route surface for versioning: create → list → view-as-of
// → rollback → diff-data over a real Postgres + the full Hono app stack, same
// harness as routes/documents-doc-views.integration.test.ts (t-5).
//
// Contract-level AC coverage: ac-1 (create-version keeps doc id/handle/status,
// bumps to the next version), ac-3 (GET /docs/:id still resolves to the
// primary with no version specified — untouched by this additive surface),
// ac-4 (every prior version is preserved + viewable as-of), ac-5 (rollback
// restores content without churning id/handle/status, auto-freezing first),
// ac-6/ac-26 (the diff endpoint can compare any two versions, including the
// live primary). std-7: unauthorized / cross-tenant reads 404, never 403.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { namespaces, memexes, users } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createOrgForUser } from "../services/orgs.js";
import { createDocDraft } from "../services/documents.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-448/acs/ac-${n}`;

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // Cascades to org / memex / doc / document_versions.
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

async function seedUser(tag: string): Promise<{ userId: string; bearer: string }> {
  const email = `versions-${tag}-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  createdUserIds.push(user.id);
  return { userId: user.id, bearer: signSessionToken(user.id) };
}

function req(path: string, init: RequestInit & { bearer?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("Host", "memex.ai");
  return Promise.resolve(app.request(path, { ...init, headers }));
}

let owner: { userId: string; bearer: string };
let outsider: { userId: string; bearer: string };
let nsSlug: string;
let memexSlug: string;
let memexId: string;
let docId: string;
let docHandle: string;
let docStatus: string;

beforeAll(async () => {
  owner = await seedUser("owner");
  outsider = await seedUser("outsider");

  const created = await createOrgForUser({
    slug: `versions-org-${owner.userId.slice(0, 8)}`,
    name: "Versions Test Co",
    userId: owner.userId,
  });
  createdNamespaceIds.push(created.namespace.id);
  nsSlug = created.namespace.slug;

  // Default visibility is 'private' (schema.ts) — deliberately NOT overridden,
  // so an outsider/anonymous request genuinely fails membership and the
  // std-7 404 posture is real, not incidental.
  const [memex] = await db
    .insert(memexes)
    .values({ namespaceId: created.namespace.id, slug: "specs", name: "Specs" })
    .returning();
  memexId = memex.id;
  memexSlug = memex.slug;

  const doc = await createDocDraft(memexId, "Versions Route Test Spec", "Purpose text", "spec");
  docId = doc.id;
  docHandle = doc.handle;
  docStatus = doc.status;
});

const base = () => `/api/${nsSlug}/${memexSlug}/versions/doc/${docId}`;
const docUrl = () => `/api/${nsSlug}/${memexSlug}/docs/${docId}`;

describe("spec-448 t-6: versions HTTP API", () => {
  let firstVersionNumber: number;

  it("ac-3: GET /docs/:id resolves to the primary with no version specified, before any version is cut", async () => {
    tagAc(AC(3));
    const res = await req(docUrl(), { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; version: number };
    expect(body.id).toBe(docId);
    expect(body.version).toBe(1);
  });

  it("ac-1, ac-14, ac-15: POST /versions/doc/:docId cuts a new version and returns it", async () => {
    tagAc(AC(1));
    tagAc(AC(14));
    tagAc(AC(15));

    const res = await req(base(), {
      method: "POST",
      bearer: owner.bearer,
      body: JSON.stringify({ name: "Route test v1", carryForward: ["decisions", "acs", "tasks", "issues", "comments"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { versionNumber: number; name: string; checksum: string };
    expect(body.versionNumber).toBe(1);
    expect(body.name).toBe("Route test v1");
    expect(body.checksum).toBeTruthy();
    firstVersionNumber = body.versionNumber;

    // ac-1: the doc keeps its id/handle/status and its version incremented.
    const docRes = await req(docUrl(), { method: "GET", bearer: owner.bearer });
    const docBody = (await docRes.json()) as { id: string; handle: string; status: string; version: number };
    expect(docBody.id).toBe(docId);
    expect(docBody.handle).toBe(docHandle);
    expect(docBody.status).toBe(docStatus);
    expect(docBody.version).toBe(2);
  });

  it("rejects an empty name (ac-15) and an unrecognised carryForward entry", async () => {
    const emptyName = await req(base(), {
      method: "POST",
      bearer: owner.bearer,
      body: JSON.stringify({ name: "", carryForward: [] }),
    });
    expect(emptyName.status).toBe(400);

    const badClass = await req(base(), {
      method: "POST",
      bearer: owner.bearer,
      body: JSON.stringify({ name: "Bad class", carryForward: ["not-a-real-class"] }),
    });
    expect(badClass.status).toBe(400);
  });

  it("ac-4: GET /versions/doc/:docId lists the cut version with the documented projection", async () => {
    tagAc(AC(4));
    const res = await req(base(), { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      versionNumber: number;
      name: string;
      createdAt: string;
      actorName: string | null;
      restoredFromVersion: number | null;
    }>;
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      versionNumber: firstVersionNumber,
      name: "Route test v1",
      restoredFromVersion: null,
    });
    expect(list[0].createdAt).toBeTruthy();
  });

  it("ac-4, ac-18: GET /versions/doc/:docId/:versionNumber returns the frozen snapshot", async () => {
    tagAc(AC(4));
    tagAc(AC(18));
    const res = await req(`${base()}/${firstVersionNumber}`, { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versionNumber: number; snapshot: { sections: unknown[] } };
    expect(body.versionNumber).toBe(firstVersionNumber);
    expect(Array.isArray(body.snapshot.sections)).toBe(true);
    expect(body.snapshot.sections.length).toBeGreaterThanOrEqual(1);
  });

  it("404s (not 400/403) for an unknown version number on a doc that IS accessible (std-7)", async () => {
    const res = await req(`${base()}/999999`, { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(404);
  });

  it("400s for a non-integer version-number path segment", async () => {
    const res = await req(`${base()}/not-a-number`, { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(400);
  });

  it("ac-6, ac-26: GET /versions/doc/:docId/diff compares the cut version against the live primary", async () => {
    tagAc(AC(6));
    tagAc(AC(26));
    const res = await req(`${base()}/diff?from=${firstVersionNumber}&to=primary`, {
      method: "GET",
      bearer: owner.bearer,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: { version: number; snapshot: { sections: unknown[] } };
      to: { version: string; snapshot: { sections: unknown[] } };
    };
    expect(body.from.version).toBe(firstVersionNumber);
    expect(body.to.version).toBe("primary");
    expect(Array.isArray(body.from.snapshot.sections)).toBe(true);
    expect(Array.isArray(body.to.snapshot.sections)).toBe(true);
  });

  it("400s for a diff request missing a side", async () => {
    const res = await req(`${base()}/diff?from=${firstVersionNumber}`, { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(400);
  });

  it("ac-5, ac-20, ac-21, ac-22, ac-23: POST /versions/doc/:docId/rollback restores content, auto-freezing first", async () => {
    tagAc(AC(5));
    tagAc(AC(20));
    tagAc(AC(21));
    tagAc(AC(22));
    tagAc(AC(23));

    const res = await req(`${base()}/rollback`, {
      method: "POST",
      bearer: owner.bearer,
      body: JSON.stringify({ sourceVersion: firstVersionNumber }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versionNumber: number; restoredFromVersion: number | null };
    expect(body.restoredFromVersion).toBe(firstVersionNumber);
    expect(body.versionNumber).toBeGreaterThan(firstVersionNumber);

    // ac-23: doc identity unchanged after rollback.
    const docRes = await req(docUrl(), { method: "GET", bearer: owner.bearer });
    const docBody = (await docRes.json()) as { id: string; handle: string; status: string };
    expect(docBody.id).toBe(docId);
    expect(docBody.handle).toBe(docHandle);
    expect(docBody.status).toBe(docStatus);

    // The list now shows the auto-freeze cut + the restore cut (ac-20).
    const listRes = await req(base(), { method: "GET", bearer: owner.bearer });
    const list = (await listRes.json()) as Array<{ versionNumber: number }>;
    expect(list.length).toBe(3); // original cut + auto-freeze + restore
  });

  it("400s a rollback with a missing/non-integer sourceVersion", async () => {
    const res = await req(`${base()}/rollback`, {
      method: "POST",
      bearer: owner.bearer,
      body: JSON.stringify({ sourceVersion: "not-a-number" }),
    });
    expect(res.status).toBe(400);
  });

  describe("std-7: unauthorized / cross-tenant access is 404, never 401/403", () => {
    it("a non-member's authenticated read 404s", async () => {
      const res = await req(base(), { method: "GET", bearer: outsider.bearer });
      expect(res.status).toBe(404);
    });

    it("an anonymous (no bearer) read 404s on a private memex", async () => {
      const res = await req(base(), { method: "GET" });
      expect(res.status).toBe(404);
    });

    it("a non-member's create/rollback write 404s (strict session gate)", async () => {
      const createRes = await req(base(), {
        method: "POST",
        bearer: outsider.bearer,
        body: JSON.stringify({ name: "Should not land", carryForward: [] }),
      });
      expect(createRes.status).toBe(404);

      const rollbackRes = await req(`${base()}/rollback`, {
        method: "POST",
        bearer: outsider.bearer,
        body: JSON.stringify({ sourceVersion: firstVersionNumber }),
      });
      expect(rollbackRes.status).toBe(404);
    });

    it("a non-member's view-as-of and diff reads both 404", async () => {
      const viewRes = await req(`${base()}/${firstVersionNumber}`, { method: "GET", bearer: outsider.bearer });
      expect(viewRes.status).toBe(404);

      const diffRes = await req(`${base()}/diff?from=${firstVersionNumber}&to=primary`, {
        method: "GET",
        bearer: outsider.bearer,
      });
      expect(diffRes.status).toBe(404);
    });
  });
});
