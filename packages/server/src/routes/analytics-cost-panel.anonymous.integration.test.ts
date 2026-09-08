// spec-552 t-3 — the cost aggregate seen by a TRULY anonymous caller (ac-11),
// and the route-surface promise it keeps (ac-16).
//
// This file deliberately does NOT set GOOGLE_CLIENT_ID="" (the pattern borrowed
// from activity.anonymous-projection.integration.test.ts). A non-empty stub
// makes isDevMode() false, so a request with no Authorization header is really
// anonymous — currentUserId null — rather than auto-logged-in as dev@memex.ai.
//
// The sibling file (analytics-cost-panel.integration.test.ts) covers the
// member and non-member cases under dev auth. That file CANNOT test anonymity:
// dev-mode auth supplies a user on every request. Splitting the file is the
// only way to reach this branch, which is why it exists.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "stub-non-empty-for-spec552-anon-test";
  return undefined;
});

import { db } from "../db/connection.js";
import {
  mcpSessions,
  mcpToolCalls,
  memexes,
  namespaces,
  orgs,
  users,
} from "../db/schema.js";
import { app } from "../app.js";
import { isDevMode } from "../middleware/session.js";
import { RESERVED_SLUGS, validateSlugFormat } from "../services/shared/slug.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-552/acs/ac-${n}`;

const VAR = "COST_PANEL_MEMEXES";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`.toLowerCase();
}

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];
const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];
let savedFlag: string | undefined;

let publicSlug: string;
let publicMemexId: string;
let privateSlug: string;

async function makeMemex(
  visibility: "public" | "private"
): Promise<{ memexId: string; slug: string }> {
  const slug = unique("cp-anon");
  return db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "org" })
      .returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Anon ${slug}` })
      .returning();
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main", visibility })
      .returning();
    createdMemexIds.push(memex.id);
    createdNamespaceIds.push(ns.id);
    return { memexId: memex.id, slug: ns.slug };
  });
}

beforeAll(async () => {
  savedFlag = process.env[VAR];
  const pub = await makeMemex("public");
  publicSlug = pub.slug;
  publicMemexId = pub.memexId;
  const priv = await makeMemex("private");
  privateSlug = priv.slug;

  // Real figures behind the gate, so "no figures" is a fact about the response
  // rather than a fact about an empty table.
  const sessionId = unique("cp-anon-sess");
  const [user] = await db
    .insert(users)
    .values({ email: `${unique("cp-anon-user")}@example.com` })
    .returning();
  createdUserIds.push(user.id);
  createdSessionIds.push(sessionId);
  await db.insert(mcpSessions).values({ sessionId, userId: user.id });
  await db.insert(mcpToolCalls).values({
    sessionId,
    userId: user.id,
    memexId: publicMemexId,
    toolName: "secret_cost_tool",
    argsJson: {},
    durationMs: 5,
    resultTextLength: 31337,
    footerTextLength: 1234,
  });

  // Both Memexes ARE on the allowlist — so anything withheld below is withheld
  // by the membership layer, not by the rollout gate.
  process.env[VAR] = `${publicSlug}/main,${privateSlug}/main`;
});

afterAll(async () => {
  if (savedFlag === undefined) delete process.env[VAR];
  else process.env[VAR] = savedFlag;
  if (createdSessionIds.length > 0) {
    await db
      .delete(mcpToolCalls)
      .where(inArray(mcpToolCalls.sessionId, createdSessionIds));
    await db
      .delete(mcpSessions)
      .where(inArray(mcpSessions.sessionId, createdSessionIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  // The PUBLIC memex here MUST be removed. spec-111-visibility-schema scans the
  // WHOLE memexes table and fails if any row is non-private, so a leaked
  // fixture reds a DIFFERENT suite and reads as an unrelated regression
  // [per std-37]. Learned the hard way: it did.
  if (createdMemexIds.length > 0) {
    await db
      .delete(memexes)
      .where(inArray(memexes.id, createdMemexIds))
      .catch(() => {});
  }
  if (createdNamespaceIds.length > 0) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
});

describe("GET /analytics/cost-panel — a truly anonymous caller (ac-11)", () => {
  // PROVE THE PREMISE FIRST. Without this the whole file is a second
  // non-member test wearing an anonymity label: dev@memex.ai is not a member of
  // either seeded Memex either, so "anonymous" and "signed-in non-member"
  // produce byte-identical responses. The assertions below cannot tell them
  // apart — only this one can.
  it("really is anonymous: dev-mode auth is OFF in this file", () => {
    tagAc(AC(11));
    expect(isDevMode()).toBe(false);
  });

  it("gets 200 with NO figures on a public Memex, not a rejection", async () => {
    tagAc(AC(11));
    const res = await app.request(
      `/api/${publicSlug}/main/analytics/cost-panel`,
      withApexHost()
    );
    // 200 rather than 401/404 on purpose: the eight sibling /analytics/*
    // endpoints answer 200 here, and Insights.tsx runs Promise.all over all of
    // them — a rejection would blank the entire page for this visitor.
    expect(res.status).toBe(200);

    const raw = await res.text();
    expect(JSON.parse(raw).available).toBe(false);
    // Membership gates the figures, and the figures exist — so their absence is
    // the gate working, not an empty table.
    expect(raw).not.toContain("secret_cost_tool");
    expect(raw).not.toContain("31337");
    expect(raw).not.toContain("1234");
  });

  it("gets 404 on a private Memex — indistinguishable from nonexistent", async () => {
    tagAc(AC(11));
    const res = await app.request(
      `/api/${privateSlug}/main/analytics/cost-panel`,
      withApexHost()
    );
    // [per std-7 cl-2] readability decides the 404, and it fires before the
    // capability question is asked. A 200 here would confirm the Memex exists.
    expect(res.status).toBe(404);

    const nonexistent = await app.request(
      "/api/no-such-namespace-anywhere/main/analytics/cost-panel",
      withApexHost()
    );
    expect(nonexistent.status).toBe(404);
    // Same status AND same body: the two must not be told apart.
    expect(await res.text()).toBe(await nonexistent.text());
  });
});

describe("the route surface this work claims (ac-16)", () => {
  it("confiscates no namespace slug — nothing was added to RESERVED_SLUGS", async () => {
    tagAc(AC(16));
    // The words this work could plausibly have claimed as a top-level path.
    // A public cost page would have needed one (dec-7, dissolved); the panel
    // rides the tenant-scoped analytics router instead, so none is reserved.
    for (const word of ["cost", "cost-panel", "costs", "usage", "tokens"]) {
      expect(RESERVED_SLUGS.has(word)).toBe(false);
      expect(validateSlugFormat(word).valid).toBe(true);
    }
  });

  it("is reachable only under the tenant-scoped path, never at a top-level root", async () => {
    tagAc(AC(16));
    // Tenant-scoped: resolves (404 here only because the namespace is unknown,
    // which is the resolver doing its job — not a missing route).
    const scoped = await app.request(
      "/api/some-unknown-ns/main/analytics/cost-panel",
      withApexHost()
    );
    expect(scoped.status).toBe(404);

    // And NOT mounted flat. A flat `/api/<root>` mount is the memexResolver
    // trap: its bare path works while its subpaths 404 in prod unless the root
    // is in RESERVED_API_ROOTS. Nothing here takes that shape.
    for (const flat of ["/api/cost-panel", "/api/cost-panel/summary"]) {
      const res = await app.request(flat, withApexHost());
      expect(res.status).not.toBe(200);
    }
  });
});
