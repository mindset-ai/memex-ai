// b-42 t-5 — Cross-tenant rejection smoke test at the /mcp HTTP boundary.
//
// Sibling to tools-coverage.regression.test.ts. That file is a pure
// schema/parity gate (no DB) and stays fast; this file adds the actual
// runtime check that calling a representative mutating tool with a ref
// pointing at a memex the caller doesn't belong to errors out before any
// DB write reaches the foreign memex.
//
// Scope (per b-42:t-5): five representative tools cover the major surfaces:
//
//   - `update_doc`        — doc-ref path (uses resolveMemexFromEntity)
//   - `update_task`       — task-ref path
//   - `update_section`    — section-ref path
//   - `resolve_decision`  — decision-ref path
//   - `add_comment`       — entity-target path with foreign section
//   - `create_doc`        — `memex` arg path (uses resolveWorkspace)
//
// The full per-tool harness across every entry in `toolSpecs` is deliberately
// deferred to b-39 Phase 1 (launch-readiness security review). The shape of
// b-39's harness is a multi-user fixture (Alice / Bob / Carol topology) which
// is a bigger setup than the smoke check here justifies.
//
// Setup mirrors `mcp/endpoint.integration.test.ts:setup`: explicit Drizzle
// inserts so the test owns its data lifecycle and doesn't need the dev-admin
// helper.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  memexes,
  orgMemberships,
  documents,
  tasks,
  decisions,
  docSections,
  docComments,
  mcpTokens,
} from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { createTask } from "../services/tasks.js";
import { createDecision } from "../services/decisions.js";
import { addTaskComment } from "../services/comments.js";

const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
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

async function makeUserMemex(suffix: string): Promise<{
  userId: string;
  memexId: string;
  nsSlug: string;
  memexSlug: string;
}> {
  const [u] = await db
    .insert(users)
    .values({
      email: `xtenant-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai`,
    } as never)
    .returning();
  created.users.push(u.id);

  const slug = `${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`
    .toLowerCase()
    .slice(0, 39);
  const [ns] = await db
    .insert(namespaces)
    .values({ slug, kind: "org" } as never)
    .returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: suffix } as never)
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ name: suffix, slug: "main", namespaceId: ns.id } as never)
    .returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({
    userId: u.id,
    orgId: org.id,
    role: "administrator",
  } as never);
  return { userId: u.id, memexId: mx.id, nsSlug: ns.slug, memexSlug: "main" };
}

async function mintTokenFor(userId: string): Promise<string> {
  const raw = `mxt_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const [tok] = await db
    .insert(mcpTokens)
    .values({
      userId,
      label: "xtenant-test",
      tokenHash,
      prefix: raw.slice(0, 12),
    } as never)
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

describe("regression: cross-tenant rejection at /mcp boundary (b-42 t-5)", () => {
  // Setup: alice and bob each own a memex. Alice is NOT a member of bob's memex.
  // Bob seeds entities in his memex; alice's MCP calls against them must error
  // before any DB write reaches bob's memex.
  let alice: Awaited<ReturnType<typeof makeUserMemex>>;
  let bob: Awaited<ReturnType<typeof makeUserMemex>>;
  let aliceToken: string;
  let bobSpecHandle: string;
  let bobTaskHandle: string;
  let bobDecisionHandle: string;
  let bobSectionHandle: string;

  beforeAll(async () => {
    alice = await makeUserMemex("alice");
    bob = await makeUserMemex("bob");
    aliceToken = await mintTokenFor(alice.userId);

    // Bob seeds entities in his memex. Canonical refs use per-doc handles
    // (spec-N / t-N / dec-N / s-N), not UUIDs — capture the handles. Pass
    // docType="spec" so the spec gets a `spec-N` handle (the canonical-ref
    // parser requires `spec-N` on the `/specs/` path).
    const spec = await createDocDraft(
      bob.memexId,
      "Bob's Spec",
      "Bob's purpose",
      "spec",
    );
    bobSpecHandle = spec.handle;
    const task = await createTask(bob.memexId, spec.id, "Bob's task", "");
    bobTaskHandle = `t-${task.seq}`;
    const dec = await createDecision(bob.memexId, spec.id, "Bob's decision");
    bobDecisionHandle = `dec-${dec.seq}`;
    const [firstSection] = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, spec.id));
    bobSectionHandle = `s-${firstSection.seq}`;
  });

  async function countBobEntities() {
    const [docCount] = await db
      .select({ n: documents.id })
      .from(documents)
      .where(eq(documents.memexId, bob.memexId));
    const taskCount = await db
      .select()
      .from(tasks)
      .where(eq(tasks.memexId, bob.memexId));
    const decCount = await db
      .select()
      .from(decisions)
      .where(eq(decisions.memexId, bob.memexId));
    const commentCount = await db
      .select()
      .from(docComments)
      .where(eq(docComments.memexId, bob.memexId));
    return {
      docs: docCount ? 1 : 0, // existence sentinel; we care about no-new-writes, not exact starting counts
      tasks: taskCount.length,
      decisions: decCount.length,
      comments: commentCount.length,
    };
  }

  async function expectRejectionAndNoWrite(toolName: string, args: unknown) {
    const before = await countBobEntities();
    const res = await mcpCall(aliceToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.isError, `${toolName}: expected isError=true`).toBe(true);
    // Membership error should mention "member" — every helper that throws
    // McpAuthError / membership-required uses that wording.
    const msg = body.result?.content?.[0]?.text ?? "";
    expect(msg.toLowerCase(), `${toolName}: error should reference membership: ${msg}`).toMatch(
      /not a member|forbidden|permission|access/,
    );
    // No DB write should have landed in bob's memex.
    const after = await countBobEntities();
    expect(after).toEqual(before);
  }

  it("update_doc on a foreign spec ref is rejected", async () => {
    const ref = `${bob.nsSlug}/${bob.memexSlug}/specs/${bobSpecHandle}`;
    await expectRejectionAndNoWrite("update_doc", {
      ref,
      title: "Alice trying to rename Bob's spec",
    });
  });

  it("update_task on a foreign task ref is rejected", async () => {
    const ref = `${bob.nsSlug}/${bob.memexSlug}/specs/${bobSpecHandle}/tasks/${bobTaskHandle}`;
    await expectRejectionAndNoWrite("update_task", {
      ref,
      status: "complete",
    });
  });

  it("update_section on a foreign section ref is rejected", async () => {
    const ref = `${bob.nsSlug}/${bob.memexSlug}/specs/${bobSpecHandle}/sections/${bobSectionHandle}`;
    await expectRejectionAndNoWrite("update_section", {
      ref,
      content: "Alice trying to rewrite Bob's section",
    });
  });

  it("resolve_decision on a foreign decision ref is rejected", async () => {
    const ref = `${bob.nsSlug}/${bob.memexSlug}/specs/${bobSpecHandle}/decisions/${bobDecisionHandle}`;
    await expectRejectionAndNoWrite("resolve_decision", {
      ref,
      resolution: "Alice trying to resolve Bob's decision",
    });
  });

  it("add_comment on a foreign section target is rejected", async () => {
    const ref = `${bob.nsSlug}/${bob.memexSlug}/specs/${bobSpecHandle}/sections/${bobSectionHandle}`;
    await expectRejectionAndNoWrite("add_comment", {
      ref,
      type: "discussion",
      authorName: "Alice",
      content: "Alice posting on Bob's section",
    });
  });

  it("create_doc with memex=<bob's memex> is rejected (resolveWorkspace path)", async () => {
    const before = await countBobEntities();
    const res = await mcpCall(aliceToken, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "create_doc",
        arguments: {
          memex: `${bob.nsSlug}/${bob.memexSlug}`,
          title: "Alice trying to create in Bob's memex",
          purpose: "should be rejected",
        },
      },
    });
    expect(res.status).toBe(200);
    const body = parseSse(await res.text());
    expect(body.result?.isError).toBe(true);
    const msg = body.result?.content?.[0]?.text ?? "";
    expect(msg.toLowerCase()).toMatch(/not a member|forbidden|permission|access/);
    const after = await countBobEntities();
    expect(after).toEqual(before);
  });
});
