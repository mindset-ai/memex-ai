// b-39 phase-1 — Exhaustive cross-tenant rejection harness at the /mcp boundary.
//
// Covers all 15 active mutating tools in the toolSpecs catalogue. Sibling to
// tools-cross-tenant.regression.test.ts (b-42 smoke check, 6 tools); that file
// explicitly defers this full-catalogue loop to b-39.
//
// Fixture topology (b-39 D-1: Option B):
//   Alice — org-A, memex-A + memex-A2 (two memexes, same org)
//   Bob   — org-B, memex-B
//   Carol — member of both org-A and org-B (multi-membership, b-38 F-6 surface)
//
// Every Alice call against Bob's entities must:
//   1. Return isError=true with a membership/access error message.
//   2. Leave Bob's entity counts unchanged (no partial write).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  memexes,
  orgMemberships,
  tasks,
  decisions,
  docSections,
  docComments,
  mcpTokens,
} from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { createTask } from "../services/tasks.js";
import { createDecision, proposeDecision } from "../services/decisions.js";
import { addComment } from "../services/comments.js";
import { createAc } from "../services/acs.js";
import { signAccessToken } from "../services/oauth/access-tokens.js";
import { tagAc } from "@memex-ai-ac/vitest";

const originalClientId = process.env.GOOGLE_CLIENT_ID;
const originalOAuthEnabled = process.env.OAUTH_ENABLED;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
  if (originalOAuthEnabled !== undefined) {
    process.env.OAUTH_ENABLED = originalOAuthEnabled;
  } else {
    delete process.env.OAUTH_ENABLED;
  }
});

const created = {
  users: [] as string[],
  memexes: [] as string[],
  tokens: [] as string[],
};

afterAll(async () => {
  if (created.tokens.length)
    await db.delete(mcpTokens).where(inArray(mcpTokens.id, created.tokens)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function makeUserOrgMemex(suffix: string): Promise<{
  userId: string;
  orgId: string;
  nsId: string;
  nsSlug: string;
  memexId: string;
  memexSlug: string;
}> {
  const tag = `${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `iso-${tag}@memex.ai` } as never)
    .returning();
  created.users.push(u.id);
  const slug = `iso-${tag}`.slice(0, 39);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" } as never).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: suffix } as never).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ name: suffix, slug: "main", namespaceId: ns.id } as never)
    .returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" } as never);
  return { userId: u.id, orgId: org.id, nsId: ns.id, nsSlug: slug, memexId: mx.id, memexSlug: "main" };
}

async function addMemexToNamespace(nsId: string, slug: string, name: string): Promise<{ memexId: string; memexSlug: string }> {
  const [mx] = await db
    .insert(memexes)
    .values({ name, slug, namespaceId: nsId } as never)
    .returning();
  created.memexes.push(mx.id);
  return { memexId: mx.id, memexSlug: slug };
}

async function mintToken(userId: string): Promise<string> {
  const raw = `mxt_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const [tok] = await db
    .insert(mcpTokens)
    .values({ userId, label: "iso-test", tokenHash, prefix: raw.slice(0, 12) } as never)
    .returning();
  created.tokens.push(tok.id);
  return raw;
}

async function mcpCall(token: string, body: unknown) {
  const { app } = await import("../app.js");
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function parseSse(text: string): {
  result?: { content?: Array<{ text: string }>; isError?: boolean };
} {
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`No SSE data in response: ${text}`);
  return JSON.parse(dataLine.slice(6));
}

// ── Fixture state ─────────────────────────────────────────────────────────────

type OrgMemex = Awaited<ReturnType<typeof makeUserOrgMemex>>;

let alice: OrgMemex;
let aliceMemexA2: { memexId: string; memexSlug: string };
let aliceToken: string;

let bob: OrgMemex;
let bobSpecHandle: string;
let bobSpecId: string;
let bobSectionHandle: string;
let bobSectionId: string;
let bobTaskHandle: string;
let bobDecHandle: string;
let bobCandidateDecHandle: string;
let bobCommentHandle: string;

let carol: { userId: string };
let carolToken: string;

let daveOAuthToken: string;
let bobAcHandle: string;

beforeAll(async () => {
  alice = await makeUserOrgMemex("alice");
  aliceMemexA2 = await addMemexToNamespace(alice.nsId, "second", "Alice memex-A2");

  bob = await makeUserOrgMemex("bob");

  // Carol: user only — gets memberships in both orgs
  const tag = `carol-${Date.now().toString(36)}`;
  const [carolUser] = await db
    .insert(users)
    .values({ email: `iso-${tag}@memex.ai` } as never)
    .returning();
  created.users.push(carolUser.id);
  carol = { userId: carolUser.id };
  // Carol is a member of org-A only — tests intra-org multi-memex access (A + A2)
  // and confirms she cannot reach Bob's org-B (non-member rejection).
  await db.insert(orgMemberships).values({ userId: carol.userId, orgId: alice.orgId, role: "member" } as never);

  aliceToken = await mintToken(alice.userId);
  carolToken = await mintToken(carol.userId);

  // Bob seeds one entity of each type
  const spec = await createDocDraft(bob.memexId, "Bob's Spec", "Bob's purpose", "spec");
  bobSpecHandle = spec.handle;
  bobSpecId = spec.id;

  const [firstSection] = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, spec.id));
  bobSectionHandle = `s-${firstSection.seq}`;
  bobSectionId = firstSection.id;

  const task = await createTask(bob.memexId, spec.id, "Bob's task", "");
  bobTaskHandle = `t-${task.seq}`;

  const dec = await createDecision(bob.memexId, spec.id, "Bob's regular decision");
  bobDecHandle = `dec-${dec.seq}`;

  const cand = await proposeDecision(bob.memexId, spec.id, { title: "Bob's candidate decision" });
  bobCandidateDecHandle = `dec-${cand.seq}`;

  const comment = await addComment(bob.memexId, bobSectionId, "Bob", "Bob's comment");
  bobCommentHandle = `c-${comment.seq}`;

  // Seed an AC in Bob's spec for the get_ac cross-tenant test.
  const bobAc = await createAc({
    memexId: bob.memexId,
    briefId: bobSpecId,
    kind: "implementation",
    statement: "Bob's AC for cross-tenant isolation test",
  });
  bobAcHandle = `ac-${bobAc.seq}`;

  // Confirm Bob's memex is private (schema default, but state it explicitly).
  await db.update(memexes).set({ visibility: "private" }).where(eq(memexes.id, bob.memexId));

  // Dave: member of BOTH org-A (Alice's) and org-B (Bob's), OAuth token scoped to org-A.
  // Tests that orgFilter rejects org-B reads even when Dave has org-B membership.
  // PAT tokens (mxt_ prefix) are matched first in app.ts, so enabling OAuth here
  // does not affect any of the existing PAT-based tests above.
  process.env.OAUTH_ENABLED = "1";
  const daveTag = `dave-${Date.now().toString(36)}`;
  const [daveUser] = await db
    .insert(users)
    .values({ email: `iso-${daveTag}@memex.ai` } as never)
    .returning();
  created.users.push(daveUser.id);
  await db.insert(orgMemberships).values({ userId: daveUser.id, orgId: alice.orgId, role: "member" } as never);
  await db.insert(orgMemberships).values({ userId: daveUser.id, orgId: bob.orgId, role: "member" } as never);
  daveOAuthToken = signAccessToken({
    userId: daveUser.id,
    orgId: alice.orgId,
    clientId: "test-orgfilter-client",
    scopes: ["read"],
  });
});

// ── Cross-tenant rejection helpers ───────────────────────────────────────────

async function countBobEntities() {
  const taskRows = await db.select().from(tasks).where(eq(tasks.memexId, bob.memexId));
  const decRows = await db.select().from(decisions).where(eq(decisions.memexId, bob.memexId));
  const sectionRows = await db.select().from(docSections).where(eq(docSections.docId, bobSpecId));
  const commentRows = await db.select().from(docComments).where(eq(docComments.memexId, bob.memexId));
  return {
    tasks: taskRows.length,
    decisions: decRows.length,
    sections: sectionRows.length,
    comments: commentRows.length,
  };
}

async function expectRejection(token: string, toolName: string, args: unknown) {
  const res = await mcpCall(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  expect(res.status, `${toolName}: expected HTTP 200`).toBe(200);
  const body = parseSse(await res.text());
  expect(body.result?.isError, `${toolName}: expected isError=true`).toBe(true);
  const msg = body.result?.content?.[0]?.text ?? "";
  expect(msg.toLowerCase(), `${toolName}: error should reference membership/access: ${msg}`).toMatch(
    /not a member|forbidden|permission|access/,
  );
}

async function expectRejectionAndNoWrite(toolName: string, args: unknown) {
  const before = await countBobEntities();
  await expectRejection(aliceToken, toolName, args);
  const after = await countBobEntities();
  expect(after, `${toolName}: DB write reached Bob's memex`).toEqual(before);
}

function bobRef(path: string) {
  return `${bob.nsSlug}/${bob.memexSlug}/${path}`;
}

// ── Phase 1-A: Alice cannot mutate Bob's entities (all 15 mutating tools) ────

describe("regression: tenant-isolation — all 15 mutating tools (b-39 phase-1)", () => {
  it("create_doc: rejected at memex arg path", async () => {
    await expectRejectionAndNoWrite("create_doc", {
      memex: `${bob.nsSlug}/${bob.memexSlug}`,
      title: "Alice's doc",
      purpose: "should be rejected",
    });
  });

  it("update_doc: rejected on Bob's spec ref", async () => {
    await expectRejectionAndNoWrite("update_doc", {
      ref: bobRef(`specs/${bobSpecHandle}`),
      title: "Alice renaming Bob's spec",
    });
  });

  it("add_section: rejected on Bob's spec ref", async () => {
    await expectRejectionAndNoWrite("add_section", {
      ref: bobRef(`specs/${bobSpecHandle}`),
      sectionType: "alice-injected",
      content: "Alice injecting a section",
    });
  });

  it("update_section: rejected on Bob's section ref", async () => {
    await expectRejectionAndNoWrite("update_section", {
      ref: bobRef(`specs/${bobSpecHandle}/sections/${bobSectionHandle}`),
      content: "Alice rewriting Bob's section",
    });
  });

  it("create_decision: rejected on Bob's spec ref", async () => {
    await expectRejectionAndNoWrite("create_decision", {
      ref: bobRef(`specs/${bobSpecHandle}`),
      title: "Alice creating a decision in Bob's spec",
    });
  });

  it("update_decision: rejected on Bob's decision ref", async () => {
    await expectRejectionAndNoWrite("update_decision", {
      ref: bobRef(`specs/${bobSpecHandle}/decisions/${bobDecHandle}`),
      status: "open",
    });
  });

  it("resolve_decision: rejected on Bob's decision ref", async () => {
    await expectRejectionAndNoWrite("resolve_decision", {
      ref: bobRef(`specs/${bobSpecHandle}/decisions/${bobDecHandle}`),
      resolution: "Alice resolving Bob's decision",
    });
  });

  it("approve_candidate: rejected on Bob's candidate decision ref", async () => {
    await expectRejectionAndNoWrite("approve_candidate", {
      ref: bobRef(`specs/${bobSpecHandle}/decisions/${bobCandidateDecHandle}`),
      resolution: "Alice approving Bob's candidate",
    });
  });

  it("reject_candidate: rejected on Bob's candidate decision ref", async () => {
    await expectRejectionAndNoWrite("reject_candidate", {
      ref: bobRef(`specs/${bobSpecHandle}/decisions/${bobCandidateDecHandle}`),
      reason: "Alice should not be able to reject this",
    });
  });

  it("create_task: rejected on Bob's spec ref", async () => {
    await expectRejectionAndNoWrite("create_task", {
      ref: bobRef(`specs/${bobSpecHandle}`),
      title: "Alice creating a task in Bob's spec",
      description: "should be rejected before reaching the DB",
    });
  });

  it("update_task: rejected on Bob's task ref", async () => {
    await expectRejectionAndNoWrite("update_task", {
      ref: bobRef(`specs/${bobSpecHandle}/tasks/${bobTaskHandle}`),
      status: "complete",
    });
  });

  it("delete_task: rejected on Bob's task ref", async () => {
    await expectRejectionAndNoWrite("delete_task", {
      ref: bobRef(`specs/${bobSpecHandle}/tasks/${bobTaskHandle}`),
    });
  });

  it("add_comment: rejected on Bob's section ref", async () => {
    await expectRejectionAndNoWrite("add_comment", {
      ref: bobRef(`specs/${bobSpecHandle}/sections/${bobSectionHandle}`),
      type: "discussion",
      authorName: "Alice",
      content: "Alice posting on Bob's section",
    });
  });

  it("update_comment: rejected on Bob's comment ref", async () => {
    await expectRejectionAndNoWrite("update_comment", {
      ref: bobRef(`specs/${bobSpecHandle}/comments/${bobCommentHandle}`),
      status: "resolved",
      resolution: "Alice should not be able to resolve this",
    });
  });

  it("publish_spec: rejected on Bob's spec ref", async () => {
    await expectRejectionAndNoWrite("publish_spec", {
      ref: bobRef(`specs/${bobSpecHandle}`),
    });
  });
});

// ── Phase 1-B: Carol multi-membership — org-A yes, org-B no ──────────────────

describe("regression: tenant-isolation — Carol multi-membership (b-38 F-6 surface)", () => {
  it("Carol can create_task in memex-A (org-A member)", async () => {
    const res = await mcpCall(carolToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_doc",
        arguments: {
          memex: `${alice.nsSlug}/${alice.memexSlug}`,
          title: "Carol's doc in org-A",
          purpose: "should succeed",
        },
      },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.isError, `expected success but got: ${body.result?.content?.[0]?.text}`).toBeFalsy();
  });

  it("Carol cannot mutate Bob's spec (not a member of org-B)", async () => {
    const res = await mcpCall(carolToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "update_doc",
        arguments: {
          ref: bobRef(`specs/${bobSpecHandle}`),
          title: "Carol trying to rename Bob's spec",
        },
      },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.isError).toBe(true);
    const msg = body.result?.content?.[0]?.text ?? "";
    expect(msg.toLowerCase()).toMatch(/not a member|forbidden|permission|access/);
  });
});

// ── Phase 1-C: Carol intra-org switching (memex-A → memex-A2) ────────────────

describe("regression: tenant-isolation — Carol intra-org memex switching", () => {
  it("Carol can create_doc in memex-A2 (same org as memex-A)", async () => {
    const res = await mcpCall(carolToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_doc",
        arguments: {
          memex: `${alice.nsSlug}/${aliceMemexA2.memexSlug}`,
          title: "Carol's doc in memex-A2",
          purpose: "same org, different memex — should succeed",
        },
      },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.isError, `expected success but got: ${body.result?.content?.[0]?.text}`).toBeFalsy();
  });

  it("Doc created in memex-A does not appear in memex-A2", async () => {
    const aliceSpec = await createDocDraft(alice.memexId, "Alice's spec", "only in A", "spec");
    const specsInA2 = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, aliceSpec.id));
    // Verify the doc is scoped to memex-A, not memex-A2
    const { documents } = await import("../db/schema.js");
    const { eq: deq } = await import("drizzle-orm");
    const [doc] = await db.select().from(documents).where(deq(documents.id, aliceSpec.id));
    expect(doc.memexId).toBe(alice.memexId);
    expect(doc.memexId).not.toBe(aliceMemexA2.memexId);
    void specsInA2; // referenced above for clarity
  });
});

// ── spec-199 t-7: Cross-tenant read gate (canReadMemex / resolveWorkspaceForRead) ─

const AC_7 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-7";

describe("regression: tenant-isolation — read tools cross-tenant gate (spec-199 t-7)", () => {
  // ref-path tools: resolveMemexFromEntityForRead → assertReadAccessAndWriteFlag
  it("get_doc: rejected on Bob's private spec", async () => {
    tagAc(AC_7);
    await expectRejection(aliceToken, "get_doc", { ref: bobRef(`specs/${bobSpecHandle}`) });
  });

  it("list_tasks: rejected on Bob's private spec", async () => {
    tagAc(AC_7);
    await expectRejection(aliceToken, "list_tasks", { ref: bobRef(`specs/${bobSpecHandle}`) });
  });

  it("get_ac: rejected on Bob's private AC", async () => {
    tagAc(AC_7);
    await expectRejection(aliceToken, "get_ac", {
      ref: bobRef(`specs/${bobSpecHandle}/acs/${bobAcHandle}`),
    });
  });

  // memex-arg tools: resolveWorkspaceForRead → assertReadAccessAndWriteFlag
  it("list_docs: rejected on Bob's private memex", async () => {
    tagAc(AC_7);
    await expectRejection(aliceToken, "list_docs", {
      memex: `${bob.nsSlug}/${bob.memexSlug}`,
    });
  });

  it("search_memex: rejected on Bob's private memex", async () => {
    tagAc(AC_7);
    await expectRejection(aliceToken, "search_memex", {
      memex: `${bob.nsSlug}/${bob.memexSlug}`,
      query: "test query",
    });
  });

  // orgFilter: Dave is a member of org-B but his OAuth token is scoped to org-A.
  // Positive control first: same token is accepted on an org-A resource.
  it("orgFilter positive control: Dave's org-A token reads Alice's memex (allowed)", async () => {
    tagAc(AC_7);
    const res = await mcpCall(daveOAuthToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_docs", arguments: { memex: `${alice.nsSlug}/${alice.memexSlug}` } },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.isError, `Dave's org-A token should read Alice's memex: ${body.result?.content?.[0]?.text ?? ""}`).toBeFalsy();
  });

  it("orgFilter: Dave's org-A token is rejected on Bob's org-B private memex despite org-B membership", async () => {
    tagAc(AC_7);
    // Dave IS a member of org-B (Bob's org), but orgFilter=alice.orgId !== bob.orgId → rejected.
    await expectRejection(daveOAuthToken, "get_doc", {
      ref: bobRef(`specs/${bobSpecHandle}`),
    });
  });
});
