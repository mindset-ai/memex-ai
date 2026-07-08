// spec-418 t-3 — DB-backed integration tests for the REST tag-CURATION surface
// (POST/PATCH/DELETE /api/<ns>/<mx>/docs/tags[/:tagId]).
//
// These drive the FULLY-ASSEMBLED Hono app over HTTP against a real Postgres
// (memexResolver → sessionMiddleware → route → tags service → DB), proving the
// SCOPE ACs end-to-end rather than at the handler/mock seam:
//   ac-2  a rename is reflected on EVERY Spec that carried the tag.
//   ac-3  a rename that would duplicate an existing tag, OR leave a Spec holding
//         two values in one scope, is refused with a clear reason and NO change.
//   ac-4  a delete removes the tag from every Spec that carried it, leaving those
//         Specs otherwise untouched.
//   ac-10 the curation endpoints require org MEMBERSHIP ONLY (no admin-role gate);
//         a NON-member request returns 404, NOT 403 (std-7) — indistinguishable
//         from not-found. A member on the same route succeeds.
//
// TAGGED with tagAc → emits to the PROD memex; a human runs this. Fixture-isolated
// per std-37 (a unique org + memex tuple per file run; distinct tags/docs per case).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

// Force AUTH-mode session middleware so per-user Bearer tokens are honored — else
// dev-mode resolves EVERY request to dev@memex.ai and the non-member case below
// would silently authenticate. Mirrors public-content-read.integration.test.ts.
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
import {
  getOrCreateTag,
  setTagOnDoc,
  listDocTags,
  listMemexTags,
  formatTag,
} from "../services/tags.js";
import type { RequestCtx } from "../services/mutate.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = "mindset-prod/memex-building-itself/specs/spec-418/acs";
const AC_2 = `${AC}/ac-2`;
const AC_3 = `${AC}/ac-3`;
const AC_4 = `${AC}/ac-4`;
const AC_10 = `${AC}/ac-10`;

const seedCtx: RequestCtx = {};

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // Deleting a namespace cascades to org / memex / membership / tags / docs.
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
});

async function seedUser(): Promise<{ userId: string; bearer: string }> {
  const email = `tagcur-${crypto.randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  await ensureUserNamespace(user.id);
  createdUserIds.push(user.id);
  return { userId: user.id, bearer: signSessionToken(user.id) };
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

// Fixtures: one org (owner = administrator MEMBER) + one memex, plus a stranger
// who is a member of NO org that owns this memex.
let owner: { userId: string; bearer: string };
let stranger: { userId: string; bearer: string };
let nsSlug: string;
let memexId: string;
const memexSlug = "main";

// The canonical curation URLs on the path-prefixed mount.
const createUrl = () => `/api/${nsSlug}/${memexSlug}/docs/tags`;
const tagUrl = (tagId: string) => `/api/${nsSlug}/${memexSlug}/docs/tags/${tagId}`;

async function makeDoc(title: string): Promise<string> {
  const doc = await createDocDraft(memexId, title, "purpose", "spec");
  return doc.id;
}

beforeAll(async () => {
  owner = await seedUser();
  stranger = await seedUser();
  const created = await createOrgForUser({
    slug: `tagcur-${owner.userId.slice(0, 8)}`,
    name: "Tag Curation Co",
    userId: owner.userId,
  });
  createdNamespaceIds.push(created.namespace.id);
  nsSlug = created.namespace.slug;
  const [memex] = await db
    .insert(memexes)
    .values({ namespaceId: created.namespace.id, slug: memexSlug, name: "Main" })
    .returning();
  memexId = memex.id;
});

describe("spec-418 t-3 — rename reflects on every carrying Spec (ac-2)", () => {
  it("PATCH /tags/:id renames the tag on every Spec that carried it, and only those", async () => {
    tagAc(AC_2);
    const docA = await makeDoc("Spec A");
    const docB = await makeDoc("Spec B");
    const docC = await makeDoc("Spec C"); // does NOT carry the tag

    const t = await getOrCreateTag(seedCtx, memexId, "priority", "high");
    await setTagOnDoc(seedCtx, memexId, docA, t);
    await setTagOnDoc(seedCtx, memexId, docB, t);

    const res = await req(tagUrl(t.id), {
      method: "PATCH",
      bearer: owner.bearer,
      body: JSON.stringify({ tag: "priority::urgent" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).value).toBe("urgent");

    // Reflected on BOTH carrying Specs; the old value survives on none of them.
    const a = (await listDocTags(memexId, docA)).map(formatTag);
    const b = (await listDocTags(memexId, docB)).map(formatTag);
    expect(a).toContain("priority::urgent");
    expect(b).toContain("priority::urgent");
    expect(a).not.toContain("priority::high");
    expect(b).not.toContain("priority::high");

    // The non-carrying Spec is untouched (no priority tag appeared on it).
    expect(await listDocTags(memexId, docC)).toEqual([]);
  });
});

describe("spec-418 t-3 — a blocked rename refuses with a reason and makes NO change (ac-3)", () => {
  it("DUPLICATE: renaming onto an existing tag → 400 with a clear reason, tag unchanged", async () => {
    tagAc(AC_3);
    const t1 = await getOrCreateTag(seedCtx, memexId, "size", "small");
    await getOrCreateTag(seedCtx, memexId, "size", "large"); // the collision target

    const res = await req(tagUrl(t1.id), {
      method: "PATCH",
      bearer: owner.bearer,
      body: JSON.stringify({ tag: "size::large" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already exists/i);

    // NO change — t1 is still size::small.
    const rows = await listMemexTags(memexId);
    expect(rows.find((r) => r.id === t1.id)?.value).toBe("small");
  });

  it("SCOPE-EXCLUSIVITY: a rename that would put two values of one scope on a Spec → 400, no change", async () => {
    tagAc(AC_3);
    const docX = await makeDoc("Spec X");
    const tOther = await getOrCreateTag(seedCtx, memexId, "team", "alpha");
    const tMove = await getOrCreateTag(seedCtx, memexId, "squad", "beta");
    await setTagOnDoc(seedCtx, memexId, docX, tOther);
    await setTagOnDoc(seedCtx, memexId, docX, tMove);

    // Renaming squad::beta → team::gamma would leave docX carrying BOTH team::alpha
    // and team::gamma (two values in the "team" scope) — refused.
    const res = await req(tagUrl(tMove.id), {
      method: "PATCH",
      bearer: owner.bearer,
      body: JSON.stringify({ tag: "team::gamma" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/team/i);

    // NO change — tMove is still squad::beta, and docX still carries exactly its two.
    const rows = await listMemexTags(memexId);
    expect(rows.find((r) => r.id === tMove.id)?.scope).toBe("squad");
    expect(rows.find((r) => r.id === tMove.id)?.value).toBe("beta");
    const dx = (await listDocTags(memexId, docX)).map(formatTag).sort();
    expect(dx).toEqual(["squad::beta", "team::alpha"]);
  });
});

describe("spec-418 t-3 — delete removes the tag from every Spec, leaving them intact (ac-4)", () => {
  it("DELETE /tags/:id removes the tag from every carrying Spec; other tags survive", async () => {
    tagAc(AC_4);
    const docP = await makeDoc("Spec P");
    const docQ = await makeDoc("Spec Q");
    const tDel = await getOrCreateTag(seedCtx, memexId, "area", "api");
    const tKeep = await getOrCreateTag(seedCtx, memexId, null, "keepme");
    await setTagOnDoc(seedCtx, memexId, docP, tDel);
    await setTagOnDoc(seedCtx, memexId, docP, tKeep);
    await setTagOnDoc(seedCtx, memexId, docQ, tDel);

    const res = await req(tagUrl(tDel.id), { method: "DELETE", bearer: owner.bearer });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(1);

    // Removed from every carrying Spec.
    const p = (await listDocTags(memexId, docP)).map(formatTag);
    const q = (await listDocTags(memexId, docQ)).map(formatTag);
    expect(p).not.toContain("area::api");
    expect(q).not.toContain("area::api");
    // docP is OTHERWISE untouched — its unrelated flat tag survives.
    expect(p).toContain("keepme");
    // docQ carried only the deleted tag, so it's now empty.
    expect(q).toEqual([]);

    // The catalogue row is gone.
    expect((await listMemexTags(memexId)).some((r) => r.id === tDel.id)).toBe(false);
  });
});

describe("spec-418 t-3 — membership-only, non-member gets 404 not 403 (ac-10, std-7)", () => {
  it("a MEMBER may PATCH; a NON-member gets 404 (not 403) on the same route, no change", async () => {
    tagAc(AC_10);
    const t = await getOrCreateTag(seedCtx, memexId, "guard", "one");

    // Member (administrator, but no admin-role gate exists — std-4 all-member) succeeds.
    const memberRes = await req(tagUrl(t.id), {
      method: "PATCH",
      bearer: owner.bearer,
      body: JSON.stringify({ tag: "guard::two" }),
    });
    expect(memberRes.status).toBe(200);

    // Non-member: 404 (indistinguishable from not-found), explicitly NOT 403.
    const strangerRes = await req(tagUrl(t.id), {
      method: "PATCH",
      bearer: stranger.bearer,
      body: JSON.stringify({ tag: "guard::three" }),
    });
    expect(strangerRes.status).toBe(404);
    expect(strangerRes.status).not.toBe(403);

    // The stranger's attempt changed nothing — still guard::two.
    expect((await listMemexTags(memexId)).find((r) => r.id === t.id)?.value).toBe("two");
  });

  it("a MEMBER may DELETE; a NON-member gets 404 (not 403) on the same route, no change", async () => {
    tagAc(AC_10);
    const t = await getOrCreateTag(seedCtx, memexId, "guard2", "one");

    // Non-member DELETE first — must 404 and leave the tag intact.
    const strangerRes = await req(tagUrl(t.id), { method: "DELETE", bearer: stranger.bearer });
    expect(strangerRes.status).toBe(404);
    expect(strangerRes.status).not.toBe(403);
    expect((await listMemexTags(memexId)).some((r) => r.id === t.id)).toBe(true);

    // Member DELETE then succeeds.
    const memberRes = await req(tagUrl(t.id), { method: "DELETE", bearer: owner.bearer });
    expect(memberRes.status).toBe(200);
    expect((await listMemexTags(memexId)).some((r) => r.id === t.id)).toBe(false);
  });

  it("POST /tags mints a catalogue tag end-to-end through the real app", async () => {
    // Route-reachability + create wiring against a real DB (createTag ACs proven at
    // the service layer in t-2; this proves the REST create path is live).
    const res = await req(createUrl(), {
      method: "POST",
      bearer: owner.bearer,
      body: JSON.stringify({ tag: "channel::rest" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scope).toBe("channel");
    expect(body.value).toBe("rest");
    expect((await listMemexTags(memexId)).some((r) => r.id === body.id)).toBe(true);
  });
});
