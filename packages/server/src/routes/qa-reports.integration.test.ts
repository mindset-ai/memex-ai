import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Force dev-mode auth so app.request() can hit session-gated routes without
// minting a JWT (same shape as activity.integration.test.ts).
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import { docSections, documents, memexes, qaReportViews } from "../db/schema.js";
import { app } from "../app.js";
import { createDocDraft } from "../services/documents.js";
import { appendQaReport } from "../services/qa-reports.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";

// spec-260 t-3/t-4 — the QA Reports feed endpoint (dec-5) + unread counter (dec-6).
//
// ac-19: cross-Spec listing, newest-first, keyset `since` pagination.
// ac-22: unread = count of reports newer than the viewer's marker, counting ALL
//        reports regardless of generator; zero after viewing.

const AC_19 = "mindset-prod/memex-building-itself/specs/spec-260/acs/ac-19";
const AC_22 = "mindset-prod/memex-building-itself/specs/spec-260/acs/ac-22";
const AC_24 = "mindset-prod/memex-building-itself/specs/spec-260/acs/ac-24";

type FeedRow = {
  id: string;
  docId: string;
  docHandle: string;
  docTitle: string;
  sectionType: string;
  version: number;
  title: string | null;
  content: string;
  actorUserId: string | null;
  actorName: string | null;
  actorKind: string;
  channel: string | null;
  createdAt: string;
};

const createdDocIds: string[] = [];
const memexIds: string[] = [];

let memexA: string;
let pathA: string;
let memexB: string;
let pathB: string;
let devUserId: string;

let specA1: { id: string; handle: string };
let specA2: { id: string; handle: string };

let r1: string; // oldest — specA1 qa_report
let r2: string; //          specA2 qa_report
let r3: string; // newest — specA1 qa_report-2
let rB: string; // memex B — must never leak into A's feed

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

// Reports are written through the REAL write path (appendQaReport → addSection →
// mutate) so the std-32 actor columns and version suffixes are genuine; only the
// timestamps are then pinned so the ordering/keyset assertions are deterministic.
async function seedReport(
  memexId: string,
  docId: string,
  content: string,
  createdAt: Date,
  actor: { actorUserId?: string; actorName?: string },
): Promise<string> {
  const section = await appendQaReport(memexId, docId, content, undefined, {
    ...actor,
    channel: "mcp",
  });
  await db
    .update(docSections)
    .set({ createdAt })
    .where(eq(docSections.id, section.id));
  return section.id;
}

beforeAll(async () => {
  const a = await makeTestMemexWithDevAdmin("qa-feed-a");
  memexA = a.memexId;
  pathA = `/api/${a.slug}/main`;
  // makeTestMemexWithDevAdmin enrols dev@memex.ai — the user app.request()
  // authenticates as under dev-mode auth, i.e. the viewer whose marker the
  // unread tests exercise.
  devUserId = (await upsertUserByEmail("dev@memex.ai")).id;
  memexIds.push(a.memexId);

  const b = await makeTestMemexWithDevAdmin("qa-feed-b");
  memexB = b.memexId;
  pathB = `/api/${b.slug}/main`;
  memexIds.push(b.memexId);

  const s1 = await createDocDraft(memexA, "QA Feed Spec One", "Purpose", "spec");
  const s2 = await createDocDraft(memexA, "QA Feed Spec Two", "Purpose", "spec");
  const sB = await createDocDraft(memexB, "QA Feed Spec B", "Purpose", "spec");
  specA1 = { id: s1.id, handle: s1.handle };
  specA2 = { id: s2.id, handle: s2.handle };
  createdDocIds.push(s1.id, s2.id, sB.id);

  const actor = { actorUserId: devUserId, actorName: "Dev Admin" };
  r1 = await seedReport(memexA, specA1.id, "Session 1 on spec one", new Date("2026-01-01T00:00:00Z"), actor);
  r2 = await seedReport(memexA, specA2.id, "Session 1 on spec two", new Date("2026-01-02T00:00:00Z"), actor);
  r3 = await seedReport(memexA, specA1.id, "Session 2 on spec one", new Date("2026-01-03T00:00:00Z"), actor);
  rB = await seedReport(memexB, sB.id, "Report in memex B", new Date("2026-01-04T00:00:00Z"), actor);
});

afterAll(async () => {
  if (memexIds.length) {
    await db.delete(qaReportViews).where(inArray(qaReportViews.memexId, memexIds)).catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
  if (memexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
  }
});

describe("GET /api/<ns>/<mx>/qa-reports (workspace feed — dec-5)", () => {
  it("ac-19: lists qa_report sections across ALL the memex's Specs, newest-first", async () => {
    tagAc(AC_19);

    const res = await app.request(`${pathA}/qa-reports`, withApexHost());
    expect(res.status).toBe(200);
    const body = (await res.json()) as FeedRow[];

    // Cross-Spec: reports from both spec one and spec two, newest first.
    expect(body.map((r) => r.id)).toEqual([r3, r2, r1]);
    // Tenant-scoped: memex B's report never appears.
    expect(body.map((r) => r.id)).not.toContain(rB);

    // Each row carries WHEN / WHICH Spec / WHO (std-32 actor on the row).
    const top = body[0]!;
    expect(top.docHandle).toBe(specA1.handle);
    expect(top.docTitle).toBe("QA Feed Spec One");
    expect(top.sectionType).toBe("qa_report-2");
    expect(top.version).toBe(2);
    expect(top.createdAt).toBe("2026-01-03T00:00:00.000Z");
    expect(top.actorName).toBe("Dev Admin");
    expect(top.actorKind).toBe("mcp_agent");
  });

  it("ac-19: keyset `since` pagination — an initial page plus Load More fetching strictly older rows", async () => {
    tagAc(AC_19);

    // Initial page of 2 → the newest two.
    const page1Res = await app.request(`${pathA}/qa-reports?limit=2`, withApexHost());
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as FeedRow[];
    expect(page1.map((r) => r.id)).toEqual([r3, r2]);

    // Load More: since = last row's createdAt → strictly OLDER rows only.
    const boundary = page1[page1.length - 1]!.createdAt;
    const page2Res = await app.request(
      `${pathA}/qa-reports?limit=2&since=${encodeURIComponent(boundary)}`,
      withApexHost(),
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as FeedRow[];
    expect(page2.map((r) => r.id)).toEqual([r1]);
  });

  it("rejects a malformed `since` / `limit` with 400 rather than silently defaulting", async () => {
    const badSince = await app.request(`${pathA}/qa-reports?since=yesterday`, withApexHost());
    expect(badSince.status).toBe(400);
    const badLimit = await app.request(`${pathA}/qa-reports?limit=-3`, withApexHost());
    expect(badLimit.status).toBe(400);
  });

  it("cross-tenant access returns 404, not 403 (std-7) for an unknown namespace", async () => {
    const res = await app.request(
      "/api/this-namespace-does-not-exist-xyz/main/qa-reports",
      withApexHost(),
    );
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });
});

describe("unread counter + view marker (dec-6)", () => {
  it("ac-22: unread counts ALL reports newer than the marker (no marker → all), and viewing zeroes it", async () => {
    tagAc(AC_22);
    tagAc(AC_24);

    // Never viewed → every report in the memex counts (3 in memex A).
    const before = await app.request(`${pathA}/qa-reports/unread`, withApexHost());
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ count: 3 });

    // Viewing the feed upserts last_viewed_at = now() → badge zeroes. The
    // receipt carries the PREVIOUS marker (ac-24): null on first-ever view —
    // the unread boundary the feed page uses to render unread rows expanded.
    const view = await app.request(`${pathA}/qa-reports/view`, withApexHost({ method: "POST" }));
    expect(view.status).toBe(200);
    const firstReceipt = (await view.json()) as {
      lastViewedAt: string;
      previousLastViewedAt: string | null;
    };
    expect(firstReceipt.previousLastViewedAt).toBeNull();
    expect(new Date(firstReceipt.lastViewedAt).getTime()).toBeGreaterThan(0);

    const after = await app.request(`${pathA}/qa-reports/unread`, withApexHost());
    expect(await after.json()).toEqual({ count: 0 });

    // A NEW report — generated by the viewer's own actor — still counts toward
    // unread (count-everything semantics: no actor filter, own-agent included).
    const r4 = await appendQaReport(memexA, specA2.id, "Session 2 on spec two", undefined, {
      actorUserId: devUserId,
      actorName: "Dev Admin",
      channel: "mcp",
    });
    expect(r4.sectionType).toBe("qa_report-2");

    const grown = await app.request(`${pathA}/qa-reports/unread`, withApexHost());
    expect(await grown.json()).toEqual({ count: 1 });

    // Re-viewing resets again (the upsert path, not a second insert) — and the
    // receipt now carries the FIRST view's marker as the previous boundary
    // (ac-24): a row created after it classifies as unread, one before it as read.
    const reView = await app.request(`${pathA}/qa-reports/view`, withApexHost({ method: "POST" }));
    expect(reView.status).toBe(200);
    const secondReceipt = (await reView.json()) as {
      lastViewedAt: string;
      previousLastViewedAt: string | null;
    };
    expect(secondReceipt.previousLastViewedAt).toBe(firstReceipt.lastViewedAt);
    const zeroed = await app.request(`${pathA}/qa-reports/unread`, withApexHost());
    expect(await zeroed.json()).toEqual({ count: 0 });
  });

  it("the unread count is per-memex — memex B's reports never bleed into A's badge", async () => {
    const resB = await app.request(`${pathB}/qa-reports/unread`, withApexHost());
    expect(resB.status).toBe(200);
    // Memex B has exactly one report and dev has never viewed B's feed.
    expect(await resB.json()).toEqual({ count: 1 });
  });
});
