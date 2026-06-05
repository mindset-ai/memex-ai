// End-to-end integration tests for the spec-158 t-3 Memex-level Issues feed.
//
//   GET /api/:namespace/:memex/issues-list?scope=&phases=&types=
//
// These hit a REAL Postgres through the full Hono app + middleware stack
// (memexResolver → sessionMiddleware → requireMemexId → listMemexIssues). The
// route is a thin REST surface over listMemexIssues (services/issues-list.ts);
// here we pin the HTTP contract: scope=mine vs scope=all, the parent-Spec phase
// filter and how it composes with scope + type, the issue-type filter, and the
// non-member 404 (std-4 / std-7).
//
// NOTE: in this working tree the issue handle is `issue-N` (spec-158 ac-14), not
// the legacy `i-N`. The feed ships the raw `seq` and the UI derives `issue-N`
// client-side, so there's no handle string to assert here — we assert on `seq`.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored
  // (mirrors search.integration.test.ts).
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { documents, issues } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { createIssue } from "../services/issues.js";
import { assign } from "../services/doc-assignees.js";
import { upsertUserByEmail } from "../services/users.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-158 — full canonical AC refs (…/acs/ac-N), never the bare handle.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-158/acs/ac-${n}`;

interface FeedRow {
  id: string;
  seq: number;
  type: "bug" | "todo";
  title: string;
  status: string;
  createdAt: string;
  spec: { docId: string; handle: string; title: string; status: string };
}
interface FeedEnvelope {
  items: FeedRow[];
}

const createdDocIds: string[] = [];
let memexId: string;
let nsSlug: string;
// Bearer for dev@memex.ai, whom makeTestMemexWithDevAdmin enrols as an
// administrator member of the seeded memex.
let memberBearer: string;
let devUserId: string;

// Specs in this Memex, seeded across phases + assignment so the filters bite.
//   assignedBuild  — assigned to dev, status 'build', carries an open bug.
//   assignedPlan   — assigned to dev, status 'plan', carries an open todo.
//   unassignedDone — NOT assigned to dev, status 'done', carries an open bug.
let assignedBuildId: string;
let assignedPlanId: string;
let unassignedDoneId: string;
// The issue ids we seed, so each test can assert on membership precisely.
let bugOnAssignedBuild: string;
let todoOnAssignedPlan: string;
let bugOnUnassignedDone: string;
// A resolved (non-open) issue on an assigned Spec — must never appear.
let resolvedIssueId: string;

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s158t3");
  memexId = made.memexId;
  nsSlug = made.slug;

  const devUser = await upsertUserByEmail("dev@memex.ai");
  devUserId = devUser.id;
  memberBearer = signSessionToken(devUser.id);

  // assignedBuild: assigned to dev, phase 'build', one open bug.
  const assignedBuild = await createDocDraft(memexId, "Assigned build spec", "Purpose", "spec");
  assignedBuildId = assignedBuild.id;
  createdDocIds.push(assignedBuildId);
  await updateDocStatus(memexId, assignedBuildId, "build");
  await assign(memexId, assignedBuildId, devUserId, devUserId);
  const bug1 = await createIssue({
    memexId,
    docId: assignedBuildId,
    title: "Bug on assigned build spec",
    body: "x",
    type: "bug",
  });
  bugOnAssignedBuild = bug1.id;

  // A resolved issue on the same Spec — open list must exclude it.
  const resolved = await createIssue({
    memexId,
    docId: assignedBuildId,
    title: "Already resolved",
    body: "x",
    type: "bug",
  });
  resolvedIssueId = resolved.id;
  await db
    .update(issues)
    .set({ status: "resolved" })
    .where(inArray(issues.id, [resolvedIssueId]));

  // assignedPlan: assigned to dev, phase 'plan', one open todo.
  const assignedPlan = await createDocDraft(memexId, "Assigned plan spec", "Purpose", "spec");
  assignedPlanId = assignedPlan.id;
  createdDocIds.push(assignedPlanId);
  await updateDocStatus(memexId, assignedPlanId, "plan");
  await assign(memexId, assignedPlanId, devUserId, devUserId);
  const todo1 = await createIssue({
    memexId,
    docId: assignedPlanId,
    title: "Todo on assigned plan spec",
    body: "x",
    type: "todo",
  });
  todoOnAssignedPlan = todo1.id;

  // unassignedDone: NOT assigned to dev, phase 'done', one open bug.
  const unassignedDone = await createDocDraft(memexId, "Unassigned done spec", "Purpose", "spec");
  unassignedDoneId = unassignedDone.id;
  createdDocIds.push(unassignedDoneId);
  await updateDocStatus(memexId, unassignedDoneId, "done");
  const bug2 = await createIssue({
    memexId,
    docId: unassignedDoneId,
    title: "Bug on unassigned done spec",
    body: "x",
    type: "bug",
  });
  bugOnUnassignedDone = bug2.id;
});

afterAll(async () => {
  if (createdDocIds.length > 0) {
    await db.delete(issues).where(inArray(issues.docId, createdDocIds)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

function req(path: string, bearer = memberBearer): Promise<Response> {
  const headers = new Headers();
  headers.set("Host", "memex.ai");
  headers.set("Authorization", `Bearer ${bearer}`);
  return Promise.resolve(app.request(path, { method: "GET", headers }));
}

const feedUrl = (params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return `/api/${nsSlug}/main/issues-list${qs ? `?${qs}` : ""}`;
};

describe("spec-158 t-3 — scope filter (ac-12)", () => {
  it("scope=mine (default) returns only open issues on Specs assigned to the requester", async () => {
    tagAc(AC(12));
    const res = await req(feedUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as FeedEnvelope;
    const ids = body.items.map((r) => r.id);
    // Open issues on dev-assigned Specs surface…
    expect(ids).toContain(bugOnAssignedBuild);
    expect(ids).toContain(todoOnAssignedPlan);
    // …the open bug on the UNASSIGNED Spec does not (scope=mine)…
    expect(ids).not.toContain(bugOnUnassignedDone);
    // …and the resolved (non-open) issue never appears.
    expect(ids).not.toContain(resolvedIssueId);
  });

  it("scope=mine is the default when no scope param is given", async () => {
    tagAc(AC(12));
    const explicit = await req(feedUrl({ scope: "mine" }));
    const implicit = await req(feedUrl());
    const a = ((await explicit.json()) as FeedEnvelope).items.map((r) => r.id).sort();
    const b = ((await implicit.json()) as FeedEnvelope).items.map((r) => r.id).sort();
    expect(a).toEqual(b);
  });

  it("scope=all returns every open issue across the Memex regardless of assignment", async () => {
    tagAc(AC(12));
    const res = await req(feedUrl({ scope: "all" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FeedEnvelope;
    const ids = body.items.map((r) => r.id);
    expect(ids).toContain(bugOnAssignedBuild);
    expect(ids).toContain(todoOnAssignedPlan);
    // The unassigned Spec's open bug NOW appears (scope=all widens the view)…
    expect(ids).toContain(bugOnUnassignedDone);
    // …but the resolved issue still doesn't (open-only list).
    expect(ids).not.toContain(resolvedIssueId);
  });
});

describe("spec-158 t-3 — parent-Spec phase filter (ac-13)", () => {
  it("returns only issues whose parent Spec status is in the requested phase set", async () => {
    tagAc(AC(13));
    // scope=all so the phase filter is the only narrowing axis. phases=done →
    // only the issue on the 'done' Spec.
    const res = await req(feedUrl({ scope: "all", phases: "done" }));
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as FeedEnvelope).items.map((r) => r.id);
    expect(ids).toContain(bugOnUnassignedDone);
    expect(ids).not.toContain(bugOnAssignedBuild); // 'build', filtered out
    expect(ids).not.toContain(todoOnAssignedPlan); // 'plan', filtered out
  });

  it("accepts a multi-phase subset (plan,build)", async () => {
    tagAc(AC(13));
    const res = await req(feedUrl({ scope: "all", phases: "plan,build" }));
    const ids = ((await res.json()) as FeedEnvelope).items.map((r) => r.id);
    expect(ids).toContain(bugOnAssignedBuild); // 'build'
    expect(ids).toContain(todoOnAssignedPlan); // 'plan'
    expect(ids).not.toContain(bugOnUnassignedDone); // 'done', excluded
  });

  it("composes with scope=mine: phase filter is applied on top of the assignment scope", async () => {
    tagAc(AC(13));
    // scope=mine narrows to assigned Specs (build + plan); phases=plan then
    // leaves only the assigned-plan Spec's todo.
    const res = await req(feedUrl({ scope: "mine", phases: "plan" }));
    const ids = ((await res.json()) as FeedEnvelope).items.map((r) => r.id);
    expect(ids).toContain(todoOnAssignedPlan);
    expect(ids).not.toContain(bugOnAssignedBuild); // assigned but 'build'
    expect(ids).not.toContain(bugOnUnassignedDone); // 'done' AND unassigned
  });

  it("composes with the type filter: phase + type narrow together", async () => {
    tagAc(AC(13));
    tagAc(AC(10)); // scope AC: type filter composes with owner + phase
    // scope=all, phases=build,plan, types=todo → only the plan-Spec todo (the
    // build-Spec issue is a bug, filtered out by type).
    const res = await req(
      feedUrl({ scope: "all", phases: "build,plan", types: "todo" }),
    );
    const ids = ((await res.json()) as FeedEnvelope).items.map((r) => r.id);
    expect(ids).toContain(todoOnAssignedPlan);
    expect(ids).not.toContain(bugOnAssignedBuild); // build, but a bug
    expect(ids).not.toContain(bugOnUnassignedDone); // done phase excluded
  });
});

describe("spec-158 t-3 — type filter", () => {
  it("types=bug returns only bug issues; types=todo only todos", async () => {
    tagAc(AC(10));
    const bugRes = await req(feedUrl({ scope: "all", types: "bug" }));
    const bugIds = ((await bugRes.json()) as FeedEnvelope).items.map((r) => r.id);
    expect(bugIds).toContain(bugOnAssignedBuild);
    expect(bugIds).toContain(bugOnUnassignedDone);
    expect(bugIds).not.toContain(todoOnAssignedPlan);

    const todoRes = await req(feedUrl({ scope: "all", types: "todo" }));
    const todoIds = ((await todoRes.json()) as FeedEnvelope).items.map((r) => r.id);
    expect(todoIds).toContain(todoOnAssignedPlan);
    expect(todoIds).not.toContain(bugOnAssignedBuild);
    expect(todoIds).not.toContain(bugOnUnassignedDone);
  });

  it("each row carries parent-Spec metadata for client-side grouping", async () => {
    const res = await req(feedUrl({ scope: "all" }));
    const items = ((await res.json()) as FeedEnvelope).items;
    const row = items.find((r) => r.id === bugOnAssignedBuild);
    expect(row).toBeDefined();
    expect(row!.spec.docId).toBe(assignedBuildId);
    expect(row!.spec.status).toBe("build");
    expect(typeof row!.spec.handle).toBe("string");
    expect(row!.spec.title).toBe("Assigned build spec");
    // issue fields present + the raw seq (UI derives issue-N from it, ac-14).
    expect(typeof row!.seq).toBe("number");
    expect(row!.type).toBe("bug");
    expect(row!.status).toBe("open");
  });
});

describe("spec-158 t-3 — org-membership gate (std-4 / std-7)", () => {
  it("a non-member with a valid token gets 404, not 403", async () => {
    const stranger = await upsertUserByEmail(`stranger-${Date.now()}@example.com`);
    const strangerBearer = signSessionToken(stranger.id);
    const res = await req(feedUrl(), strangerBearer);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("an unknown namespace/memex returns 404", async () => {
    const res = await req(
      `/api/no-such-namespace-${Date.now()}/nope/issues-list`,
    );
    expect(res.status).toBe(404);
  });
});
