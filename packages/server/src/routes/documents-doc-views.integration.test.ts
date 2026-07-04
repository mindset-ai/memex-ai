// spec-448 t-5 — GET /docs/:id piggybacks the per-user "last-seen version"
// marker (doc_views) and returns catch-up state in the payload.
//
// ac-8:  the marker advances on an authenticated web open.
// ac-36: an ANONYMOUS read writes nothing to doc_views.
// ac-39: the GET /docs/:id payload carries the viewer's catch-up state
//        (computed from the marker BEFORE this read advances it) so the
//        client needs no extra fetch.
//
// Hits a REAL Postgres through the full Hono app + middleware stack, exactly
// like routes/public-content-read.integration.test.ts — auth-mode session
// middleware (not dev-mode) so a request with no bearer is genuinely
// anonymous, and a signed JWT lets us act as a specific, real user.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { namespaces, memexes, users, docViews } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { createOrgForUser } from "../services/orgs.js";
import { createDocDraft } from "../services/documents.js";
import { cutVersion } from "../services/versioning.js";

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-8";
const AC_36 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-36";
const AC_39 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-39";

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // Cascades to org / memex / doc / doc_views.
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

async function seedUser(): Promise<{ userId: string; bearer: string }> {
  const email = `dv-viewer-${crypto.randomUUID()}@example.com`;
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
  headers.set("Host", "memex.ai");
  return Promise.resolve(app.request(path, { ...init, headers }));
}

let owner: { userId: string; bearer: string };
let nsSlug: string;
let memexSlug: string;
let memexId: string;
let docId: string;

beforeAll(async () => {
  owner = await seedUser();
  const created = await createOrgForUser({
    slug: `dv-org-${owner.userId.slice(0, 8)}`,
    name: "DocViews Test Co",
    userId: owner.userId,
  });
  createdNamespaceIds.push(created.namespace.id);
  nsSlug = created.namespace.slug;

  // PUBLIC memex so an anonymous GET reaches the handler (200), not a 404 —
  // otherwise ac-36 ("anonymous read writes nothing") would be untestable: a
  // blocked read can't write anything either, which would prove nothing.
  const [memex] = await db
    .insert(memexes)
    .values({ namespaceId: created.namespace.id, slug: "specs", name: "Specs", visibility: "public" })
    .returning();
  memexId = memex.id;
  memexSlug = memex.slug;

  const doc = await createDocDraft(memexId, "DocViews Test Spec", "Purpose", "spec");
  docId = doc.id;
});

const detailUrl = () => `/api/${nsSlug}/${memexSlug}/docs/${docId}`;

describe("spec-448 t-5: GET /docs/:id — doc_views stamping + catch-up payload", () => {
  it("ac-36: an anonymous read returns 200 (public memex) but writes NO doc_views row", async () => {
    tagAc(AC_36);
    const res = await req(detailUrl(), { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { catchUp: { hasCatchUp: boolean; fromVersion: number | null } };
    expect(body.catchUp).toEqual({ hasCatchUp: false, fromVersion: null, lastViewedVersion: null });

    const rows = await db.select().from(docViews).where(eq(docViews.docId, docId));
    expect(rows).toHaveLength(0);
  });

  it("ac-8 / ac-39: an authenticated read stamps the marker and reports pre-read catch-up state", async () => {
    tagAc(AC_8);
    tagAc(AC_39);

    const res = await req(detailUrl(), { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      catchUp: { hasCatchUp: boolean; fromVersion: number | null; lastViewedVersion: number | null };
    };
    // First-ever view: no PRIOR marker, so catchUp reads as "never viewed" —
    // not "behind" — even though this very read is about to create one.
    expect(body.catchUp).toEqual({ hasCatchUp: false, fromVersion: null, lastViewedVersion: null });

    const rows = await db.select().from(docViews).where(eq(docViews.docId, docId));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.userId);
    expect(rows[0].lastViewedVersion).toBe(body.version);
    expect(rows[0].channel).toBe("rest_ui");
  });

  it("ac-39: cutting a new version puts the marker behind; the NEXT authenticated read reports hasCatchUp before re-advancing it", async () => {
    tagAc(AC_39);

    const [priorMarker] = await db.select().from(docViews).where(eq(docViews.docId, docId));
    const priorVersion = priorMarker.lastViewedVersion;

    await cutVersion(memexId, docId, "t-5 integration test cut", []);

    const res = await req(detailUrl(), { method: "GET", bearer: owner.bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      catchUp: { hasCatchUp: boolean; fromVersion: number | null; lastViewedVersion: number | null };
    };
    expect(body.version).toBeGreaterThan(priorVersion);
    expect(body.catchUp).toEqual({
      hasCatchUp: true,
      fromVersion: priorVersion,
      lastViewedVersion: priorVersion,
    });

    // The read that just reported "you were behind" also re-advances the
    // marker for next time (ac-8) — the very next read is caught up again.
    const [advanced] = await db.select().from(docViews).where(eq(docViews.docId, docId));
    expect(advanced.lastViewedVersion).toBe(body.version);

    const res2 = await req(detailUrl(), { method: "GET", bearer: owner.bearer });
    const body2 = (await res2.json()) as { catchUp: { hasCatchUp: boolean } };
    expect(body2.catchUp.hasCatchUp).toBe(false);
  });
});
