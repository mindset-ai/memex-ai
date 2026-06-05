// End-to-end integration tests for the spec-111 t-10 PUBLIC CONTENT read path.
//
// The chrome of a public Memex already renders (t-5/t-6), but the actual
// content — specs, decisions, tasks, ACs, comments — is served by the
// tenant-scoped content routers (documents / decisions / tasks / acs / comments
// / activity). Before t-10 those routers sat behind STRICT sessionMiddleware,
// so a non-member could not load any content even on a PUBLIC Memex.
//
// t-10 moves every GET read handler behind the PERMISSIVE publicSessionMiddleware
// and gates the resolved memex on canReadMemex (via resolveReadableMemexId):
//
//   - PUBLIC memex  → anyone (anonymous, signed-in non-member, member) reads.
//   - PRIVATE memex → non-members + anonymous get 404 (std-7, indistinguishable
//                     from non-existent); members still read.
//   - WRITES stay locked: every POST/PATCH/DELETE keeps strict sessionMiddleware,
//     so an anonymous mutation can never reach a handler (401/404, never 200).
//
// These hit a REAL Postgres through the full Hono app + middleware stack:
// memexResolver → publicSessionMiddleware/sessionMiddleware → canReadMemex.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored.
  // Without this, dev-mode would resolve every request to dev@memex.ai and the
  // anonymous / non-member cases below would silently authenticate.
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
import { createDecision } from "../services/decisions.js";
import { createTask } from "../services/tasks.js";
import { tagAc } from "@memex-ai-ac/vitest";

// ac-1: a non-member (or anonymous visitor) can READ a public Memex's content
// but cannot write it.
const AC_1 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-1";

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // Deleting a namespace cascades to org / memex / membership / content rows.
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
});

async function seedUser(): Promise<{ userId: string; bearer: string }> {
  const email = `pubread-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  createdUserIds.push(user.id);
  return { userId: user.id, bearer: signSessionToken(user.id) };
}

interface SeededMemex {
  nsSlug: string;
  memexSlug: string;
  memexId: string;
  docId: string;
  docHandle: string;
  decisionId: string;
  taskId: string;
}

// Creates an org (owner = administrator member) with one memex of the given
// visibility, seeded with a doc + one decision + one task so the read routes
// have content to return.
async function seedOrgWithContent(
  visibility: "public" | "private",
  ownerUserId: string,
  ownerSlugSeed: string,
): Promise<SeededMemex> {
  const created = await createOrgForUser({
    slug: `pub-${ownerSlugSeed}`,
    name: "Public Read Co",
    userId: ownerUserId,
  });
  createdNamespaceIds.push(created.namespace.id);

  const [memex] = await db
    .insert(memexes)
    .values({
      namespaceId: created.namespace.id,
      slug: "specs",
      name: "Specs",
      visibility,
    })
    .returning();

  const doc = await createDocDraft(
    memex.id,
    "Public Spec",
    "A spec rendered on the public Memex view",
    "spec",
  );
  const decision = await createDecision(
    memex.id,
    doc.id,
    "A decision in the public spec",
    "context for the decision",
  );
  const task = await createTask(
    memex.id,
    doc.id,
    "A task in the public spec",
    "do the thing",
  );

  return {
    nsSlug: created.namespace.slug,
    memexSlug: memex.slug,
    memexId: memex.id,
    docId: doc.id,
    docHandle: doc.handle,
    decisionId: decision.id,
    taskId: task.id,
  };
}

function req(
  path: string,
  init: RequestInit & { bearer?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Host", "memex.ai");
  return Promise.resolve(app.request(path, { ...init, headers }));
}

// Shared fixtures: one public memex + one private memex, each with content, plus
// an owner (org member) and a non-member stranger.
let owner: { userId: string; bearer: string };
let stranger: { userId: string; bearer: string };
let pub: SeededMemex;
let priv: SeededMemex;

beforeAll(async () => {
  owner = await seedUser();
  stranger = await seedUser();
  pub = await seedOrgWithContent("public", owner.userId, owner.userId.slice(0, 6));
  // Private memex owned by a DIFFERENT org owner so `owner` is a non-member of it
  // and we can also assert the original owner reads their own private memex.
  priv = await seedOrgWithContent("private", owner.userId, `${owner.userId.slice(0, 6)}b`);
});

// Helpers that build the canonical read URLs for a memex's seeded content.
const specListUrl = (m: SeededMemex) => `/api/${m.nsSlug}/${m.memexSlug}/docs`;
const specDetailUrl = (m: SeededMemex) =>
  `/api/${m.nsSlug}/${m.memexSlug}/docs/${m.docId}`;
const decisionsUrl = (m: SeededMemex) =>
  `/api/${m.nsSlug}/${m.memexSlug}/decisions/doc/${m.docId}`;
const tasksUrl = (m: SeededMemex) =>
  `/api/${m.nsSlug}/${m.memexSlug}/tasks/doc/${m.docId}`;
const acsUrl = (m: SeededMemex) =>
  `/api/${m.nsSlug}/${m.memexSlug}/acs/doc/${m.docId}`;
const activityUrl = (m: SeededMemex) =>
  `/api/${m.nsSlug}/${m.memexSlug}/activity`;

describe("spec-111 t-10 — anonymous reads a PUBLIC Memex's content (ac-1)", () => {
  it("spec list returns the seeded doc to an anonymous caller", async () => {
    tagAc(AC_1);
    const res = await req(specListUrl(pub), { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((d) => d.id === pub.docId)).toBe(true);
  });

  it("spec detail (with decisions + tasks) returns to an anonymous caller", async () => {
    tagAc(AC_1);
    const res = await req(specDetailUrl(pub), { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      decisions: Array<{ id: string }>;
      tasks: Array<{ id: string }>;
    };
    expect(body.id).toBe(pub.docId);
    expect(body.decisions.some((d) => d.id === pub.decisionId)).toBe(true);
    expect(body.tasks.some((t) => t.id === pub.taskId)).toBe(true);
  });

  it("decisions list returns to an anonymous caller", async () => {
    tagAc(AC_1);
    const res = await req(decisionsUrl(pub), { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((d) => d.id === pub.decisionId)).toBe(true);
  });

  it("tasks list returns to an anonymous caller", async () => {
    tagAc(AC_1);
    const res = await req(tasksUrl(pub), { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((t) => t.id === pub.taskId)).toBe(true);
  });

  it("ACs list returns to an anonymous caller", async () => {
    tagAc(AC_1);
    const res = await req(acsUrl(pub), { method: "GET" });
    expect(res.status).toBe(200);
    // The seeded doc has no ACs yet; the point is the route resolves + 200s
    // rather than 401/404 for an anonymous public read.
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("activity (Pulse) timeline returns to an anonymous caller", async () => {
    tagAc(AC_1);
    const res = await req(activityUrl(pub), { method: "GET" });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("spec-111 t-10 — anonymous read of a PRIVATE Memex → 404 (std-7)", () => {
  it("spec list → 404", async () => {
    tagAc(AC_1);
    expect((await req(specListUrl(priv), { method: "GET" })).status).toBe(404);
  });
  it("spec detail → 404", async () => {
    tagAc(AC_1);
    expect((await req(specDetailUrl(priv), { method: "GET" })).status).toBe(404);
  });
  it("decisions list → 404", async () => {
    tagAc(AC_1);
    expect((await req(decisionsUrl(priv), { method: "GET" })).status).toBe(404);
  });
  it("tasks list → 404", async () => {
    tagAc(AC_1);
    expect((await req(tasksUrl(priv), { method: "GET" })).status).toBe(404);
  });
  it("ACs list → 404", async () => {
    tagAc(AC_1);
    expect((await req(acsUrl(priv), { method: "GET" })).status).toBe(404);
  });
  it("activity → 404", async () => {
    tagAc(AC_1);
    expect((await req(activityUrl(priv), { method: "GET" })).status).toBe(404);
  });
});

describe("spec-111 t-10 — signed-in NON-member: public 200 / private 404", () => {
  it("non-member reads the public memex's spec list (200)", async () => {
    tagAc(AC_1);
    const res = await req(specListUrl(pub), { method: "GET", bearer: stranger.bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((d) => d.id === pub.docId)).toBe(true);
  });

  it("non-member reads the public memex's spec detail (200)", async () => {
    tagAc(AC_1);
    const res = await req(specDetailUrl(pub), {
      method: "GET",
      bearer: stranger.bearer,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(pub.docId);
  });

  it("non-member is 404 on the private memex's spec list (std-7)", async () => {
    tagAc(AC_1);
    const res = await req(specListUrl(priv), {
      method: "GET",
      bearer: stranger.bearer,
    });
    expect(res.status).toBe(404);
  });

  it("non-member is 404 on the private memex's spec detail (std-7)", async () => {
    tagAc(AC_1);
    const res = await req(specDetailUrl(priv), {
      method: "GET",
      bearer: stranger.bearer,
    });
    expect(res.status).toBe(404);
  });
});

describe("spec-111 t-10 — org MEMBER still reads both public + private (no regression)", () => {
  it("member reads their public memex spec list (200)", async () => {
    const res = await req(specListUrl(pub), { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((d) => d.id === pub.docId)).toBe(true);
  });

  it("member reads their PRIVATE memex spec list + detail (200)", async () => {
    const list = await req(specListUrl(priv), { method: "GET", bearer: owner.bearer });
    expect(list.status).toBe(200);
    const detail = await req(specDetailUrl(priv), {
      method: "GET",
      bearer: owner.bearer,
    });
    expect(detail.status).toBe(200);
    expect((await detail.json()).id).toBe(priv.docId);
  });

  it("member reads decisions + tasks on the private memex (200)", async () => {
    expect(
      (await req(decisionsUrl(priv), { method: "GET", bearer: owner.bearer })).status,
    ).toBe(200);
    expect(
      (await req(tasksUrl(priv), { method: "GET", bearer: owner.bearer })).status,
    ).toBe(200);
  });
});

describe("spec-111 t-10 — WRITES stay locked on a PUBLIC Memex (ac-1)", () => {
  it("anonymous decision-create POST never succeeds (401/404, never 200)", async () => {
    tagAc(AC_1);
    const res = await req(
      `/api/${pub.nsSlug}/${pub.memexSlug}/decisions/doc/${pub.docId}`,
      {
        method: "POST",
        body: JSON.stringify({ title: "anon should not write" }),
      },
    );
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
    expect([401, 404]).toContain(res.status);
  });

  it("anonymous task-create POST never succeeds (401/404, never 200)", async () => {
    tagAc(AC_1);
    const res = await req(`/api/${pub.nsSlug}/${pub.memexSlug}/tasks/doc/${pub.docId}`, {
      method: "POST",
      body: JSON.stringify({ title: "x", description: "y" }),
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
    expect([401, 404]).toContain(res.status);
  });

  it("signed-in NON-member decision-create POST on a public memex is rejected (404, std-7)", async () => {
    tagAc(AC_1);
    const res = await req(
      `/api/${pub.nsSlug}/${pub.memexSlug}/decisions/doc/${pub.docId}`,
      {
        method: "POST",
        bearer: stranger.bearer,
        body: JSON.stringify({ title: "non-member should not write" }),
      },
    );
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
    expect([401, 404]).toContain(res.status);
  });

  it("anonymous doc archive POST never succeeds", async () => {
    tagAc(AC_1);
    const res = await req(
      `/api/${pub.nsSlug}/${pub.memexSlug}/docs/${pub.docId}/archive`,
      { method: "POST" },
    );
    expect(res.status).not.toBe(200);
    expect([401, 404]).toContain(res.status);
  });

  it("the public doc was NOT mutated by any rejected write", async () => {
    tagAc(AC_1);
    // Re-read the doc via the public read path; it must still be present + draft
    // (no rejected write archived or otherwise mutated it).
    const res = await req(specDetailUrl(pub), { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(pub.docId);
    expect(body.status).not.toBe("archived");
  });
});
