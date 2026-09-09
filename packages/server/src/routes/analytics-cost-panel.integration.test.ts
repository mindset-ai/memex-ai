// spec-552 t-3 — the gated cost aggregate: GET /analytics/cost-panel.
//
// Written BEFORE the endpoint (TDD). The four assertions that matter are the
// authorization matrix and the migration-straddle arithmetic; the happy path is
// the easy part.
//
// TWO LAYERS, and neither alone passes (dec-9):
//   readability decides the 404      — a non-member of a PRIVATE memex must not
//                                      learn it exists [per std-7 cl-2]
//   membership decides the figures   — a non-member of a PUBLIC memex gets 200
//                                      with none, because a 404 there would
//                                      blank all eight existing Insights cards
//                                      under Insights.tsx's Promise.all
//
// Real Postgres + real app routing, same shape as analytics.integration.test.ts.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";

// Dev-mode auth so app.request() carries the dev user without minting a JWT.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
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
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-552/acs/ac-${n}`;

const VAR = "COST_PANEL_MEMEXES";

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`.toLowerCase();
}

// A memex the dev user is NOT a member of. Mirrors makeTestMemexWithDevAdmin
// minus the org_memberships insert — that omission IS the fixture.
async function makeForeignMemex(
  visibility: "public" | "private"
): Promise<{ memexId: string; slug: string }> {
  const slug = unique("cp-foreign");
  return db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "org" })
      .returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Foreign ${slug}` })
      .returning();
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main", visibility })
      .returning();
    createdNamespaceIds.push(ns.id);
    return { memexId: memex.id, slug: ns.slug };
  });
}

// One mcp_tool_calls row. `resultLen` null models a row written BEFORE
// migration 0144 — the straddle case that must not be counted.
async function seedCall(over: {
  memexId: string;
  toolName: string;
  verb?: string | null;
  resultLen: number | null;
  footerLen?: number | null;
}): Promise<void> {
  const sessionId = unique("cp-sess");
  const [user] = await db
    .insert(users)
    .values({ email: `${unique("cp-user")}@example.com` })
    .returning();
  createdUserIds.push(user.id);
  createdSessionIds.push(sessionId);
  await db.insert(mcpSessions).values({ sessionId, userId: user.id });
  await db.insert(mcpToolCalls).values({
    sessionId,
    userId: user.id,
    memexId: over.memexId,
    toolName: over.toolName,
    verb: over.verb ?? null,
    argsJson: {},
    durationMs: 5,
    resultTextLength: over.resultLen,
    footerTextLength: over.footerLen ?? null,
  });
}

const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];
const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];

let memberSlug: string;
let memberMemexId: string;
let savedFlag: string | undefined;

beforeAll(async () => {
  savedFlag = process.env[VAR];
  const member = await makeTestMemexWithDevAdmin("cp-member");
  memberSlug = member.slug;
  memberMemexId = member.memexId;
  createdMemexIds.push(member.memexId);
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
  // Remove the memexes and their namespaces. The PUBLIC one especially:
  // spec-111-visibility-schema scans the WHOLE memexes table and fails if any
  // row is non-private, so a leaked fixture reds a DIFFERENT suite and reads as
  // an unrelated regression [per std-37]. Learned the hard way: it did.
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

function pathFor(slug: string): string {
  return `/api/${slug}/main/analytics/cost-panel`;
}

function openTo(...slugs: string[]): void {
  process.env[VAR] = slugs.map((s) => `${s}/main`).join(",");
}

// ── the happy path ───────────────────────────────────────────────────────────

describe("GET /analytics/cost-panel — a member of an allowlisted Memex", () => {
  it("returns per-operation counts, median and p90 in CHARACTERS", async () => {
    tagAc(AC(1));
    // ac-3's server half: every figure is computed from mcp_tool_calls rows
    // seeded below, never authored. Change the rows and the numbers change.
    tagAc(AC(3));
    openTo(memberSlug);
    // Five calls with known lengths: median 300, p90 ~460 (interpolated).
    for (const len of [100, 200, 300, 400, 500]) {
      await seedCall({
        memexId: memberMemexId,
        toolName: "get_doc",
        resultLen: len,
        footerLen: 50,
      });
    }

    const res = await app.request(pathFor(memberSlug), withApexHost());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.available).toBe(true);
    const row = body.operations.find(
      (o: { tool: string }) => o.tool === "get_doc"
    );
    expect(row).toBeDefined();
    expect(row.calls).toBe(5);
    expect(row.medianChars).toBe(300);
    expect(row.p90Chars).toBeGreaterThan(400);
    // Guidance is carried separately so the card can show the share; the ANSWER
    // half is derived (result − footer) and never stored.
    expect(row.guidanceChars).toBeGreaterThan(0);
    // Characters, not tokens — dec-5 keeps the conversion in the UI.
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });

  it("counts only rows that HAVE a length, so the window may straddle migration 0144", async () => {
    tagAc(AC(1));
    openTo(memberSlug);
    // Three measured rows and two pre-migration NULLs for one tool.
    for (const len of [1000, 2000, 3000]) {
      await seedCall({
        memexId: memberMemexId,
        toolName: "straddle_tool",
        resultLen: len,
        footerLen: 100,
      });
    }
    await seedCall({ memexId: memberMemexId, toolName: "straddle_tool", resultLen: null });
    await seedCall({ memexId: memberMemexId, toolName: "straddle_tool", resultLen: null });

    const res = await app.request(pathFor(memberSlug), withApexHost());
    const body = await res.json();
    const row = body.operations.find(
      (o: { tool: string }) => o.tool === "straddle_tool"
    );
    // The trap: count(*) would say 5 beside a median drawn from 3. n must
    // describe the same set the median does.
    expect(row.calls).toBe(3);
    expect(row.medianChars).toBe(2000);
  });

  it("returns p90Chars on a single-call row too — the display gates, not the API", async () => {
    tagAc(AC(26));
    openTo(memberSlug);
    // dec-10 withholds a thin row's p90 IN THE CARD. The temptation once that
    // ships is to "finish the job" server-side and null the column here, which
    // would break spec-458 dec-5 — the endpoint always returns the truth, and
    // display gating is a page concern. It would also silently disarm the UI
    // test: a card asked to hide a value it never receives would pass for the
    // wrong reason.
    await seedCall({
      memexId: memberMemexId,
      toolName: "lonely_tool",
      resultLen: 4242,
      footerLen: 42,
    });

    const res = await app.request(pathFor(memberSlug), withApexHost());
    const body = await res.json();
    const row = body.operations.find(
      (o: { tool: string }) => o.tool === "lonely_tool"
    );
    expect(row.calls).toBe(1);
    // Present, numeric, and equal to the only observation there is.
    expect(row.p90Chars).toBe(4242);
    expect(row.medianChars).toBe(4242);
  });

  it("groups on (tool, verb): NULL verbs collapse, distinct verbs split", async () => {
    tagAc(AC(14));
    openTo(memberSlug);
    // Today every row has verb NULL. After spec-511 the same tool name carries
    // several verbs whose payloads differ by ~5.5x, so both shapes are proven
    // now — before spec-511 exists.
    await seedCall({ memexId: memberMemexId, toolName: "nullverb_tool", resultLen: 700 });
    await seedCall({ memexId: memberMemexId, toolName: "nullverb_tool", resultLen: 900 });
    await seedCall({ memexId: memberMemexId, toolName: "verbed_tool", verb: "create", resultLen: 100 });
    await seedCall({ memexId: memberMemexId, toolName: "verbed_tool", verb: "resolve", resultLen: 5000 });

    const res = await app.request(pathFor(memberSlug), withApexHost());
    const body = await res.json();

    const nullVerb = body.operations.filter(
      (o: { tool: string }) => o.tool === "nullverb_tool"
    );
    expect(nullVerb).toHaveLength(1);
    expect(nullVerb[0].calls).toBe(2);
    expect(nullVerb[0].verb).toBeNull();

    const verbed = body.operations
      .filter((o: { tool: string }) => o.tool === "verbed_tool")
      .sort((a: { verb: string }, b: { verb: string }) => a.verb.localeCompare(b.verb));
    expect(verbed).toHaveLength(2);
    expect(verbed.map((o: { verb: string }) => o.verb)).toEqual(["create", "resolve"]);
    expect(verbed[0].medianChars).toBe(100);
    expect(verbed[1].medianChars).toBe(5000);
  });

  it("never carries a user_id or a per-user row", async () => {
    tagAc(AC(8));
    openTo(memberSlug);
    await seedCall({ memexId: memberMemexId, toolName: "anon_tool", resultLen: 400 });

    const res = await app.request(pathFor(memberSlug), withApexHost());
    const raw = await res.text();
    // Anonymity that depends on the client declining to render a field it
    // received is not anonymity — aggregate before the response leaves.
    expect(raw).not.toMatch(/user_?id/i);
    expect(raw).not.toMatch(/actor/i);
  });

  it("never leaks another tenant's rows — the memex_id predicate is the ONLY guarantee", async () => {
    tagAc(AC(9));
    // mcp_tool_calls is excluded from RLS (drizzle/0081:37), so there is no
    // database-level second line. This is the assertion that stands in for it.
    openTo(memberSlug);
    const foreign = await makeForeignMemex("private");
    createdMemexIds.push(foreign.memexId);
    await seedCall({
      memexId: foreign.memexId,
      toolName: "other_tenant_tool",
      resultLen: 9999,
    });

    const res = await app.request(pathFor(memberSlug), withApexHost());
    const raw = await res.text();
    expect(raw).not.toContain("other_tenant_tool");
    expect(raw).not.toContain("9999");
  });
});

// ── the authorization matrix (dec-9) ────────────────────────────────────────

describe("GET /analytics/cost-panel — the two layers", () => {
  it("a member of a Memex NOT on the allowlist gets 200 with no figures", async () => {
    tagAc(AC(19));
    process.env[VAR] = "someone-else/main";
    const res = await app.request(pathFor(memberSlug), withApexHost());
    // 200, not an error: Insights.tsx runs Promise.all over nine endpoints and
    // one rejection blanks the whole page.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.operations).toBeUndefined();
  });

  it("a non-member of a PUBLIC Memex gets 200 with no figures, not a 404", async () => {
    tagAc(AC(21));
    const publicForeign = await makeForeignMemex("public");
    createdMemexIds.push(publicForeign.memexId);
    openTo(publicForeign.slug); // on the allowlist, but the caller is not a member
    await seedCall({
      memexId: publicForeign.memexId,
      toolName: "public_foreign_tool",
      resultLen: 4242,
    });

    const res = await app.request(pathFor(publicForeign.slug), withApexHost());
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw).available).toBe(false);
    // Membership gates the FIGURES, so none of them appear.
    expect(raw).not.toContain("public_foreign_tool");
    expect(raw).not.toContain("4242");
  });

  it("a non-member of a PRIVATE Memex gets 404 — indistinguishable from nonexistent", async () => {
    tagAc(AC(21));
    const privateForeign = await makeForeignMemex("private");
    createdMemexIds.push(privateForeign.memexId);
    openTo(privateForeign.slug);

    const res = await app.request(pathFor(privateForeign.slug), withApexHost());
    // [per std-7 cl-2] readability decides the 404, and it happens BEFORE the
    // capability question is asked — otherwise a 200 would confirm a private
    // Memex exists.
    expect(res.status).toBe(404);

    const unknown = await app.request(
      "/api/no-such-namespace-at-all/main/analytics/cost-panel",
      withApexHost()
    );
    expect(unknown.status).toBe(404);
  });

  it("the two closed states are byte-identical, so the allowlist cannot be enumerated", async () => {
    tagAc(AC(22));
    // Closed because not a member (public foreign, on the list)…
    const publicForeign = await makeForeignMemex("public");
    createdMemexIds.push(publicForeign.memexId);
    openTo(publicForeign.slug);
    const notMember = await app.request(
      pathFor(publicForeign.slug),
      withApexHost()
    );
    const notMemberBody = await notMember.text();

    // …and closed because not on the list (our own memex, member).
    process.env[VAR] = "";
    const notListed = await app.request(pathFor(memberSlug), withApexHost());
    const notListedBody = await notListed.text();

    expect(notMember.status).toBe(notListed.status);
    expect(notMemberBody).toBe(notListedBody);
  });

  it("the gate defaults closed for a member when the flag is unset", async () => {
    tagAc(AC(19));
    delete process.env[VAR];
    const res = await app.request(pathFor(memberSlug), withApexHost());
    expect(res.status).toBe(200);
    expect((await res.json()).available).toBe(false);
  });
});
