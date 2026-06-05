// b-39 phase-2 — Adversarial scenario suite.
//
// Six net-new scenarios (trimmed from the original ten per b-39 D-2):
//
//   S1  — Concurrent task creation: five simultaneous MCP create_task calls; all
//          succeed with distinct t-N handles (withSeqRetry under real concurrency).
//   S3  — Cross-Spec dec-N scoping: dec-1 exists in two specs in the same memex;
//          resolving via spec-A path only affects spec-A's dec-1.
//   S4  — Workspace switching (Carol, memex-A → memex-A2): two memexes in the same
//          org; docs land in the correct memex with no cross-contamination.
//   S9  — REST memexId tamper: createTask(aliceMemexId, bobDocId) → NotFoundError
//          before any write (service-layer enforcement).
//   S10 — Stale-config replay: calling with old arg names (docId instead of ref)
//          returns a structured migration hint, not a raw Zod dump.
//   S-share — Share-token scope: token minted for doc-A returns doc-A; an
//              unknown token returns 404.
//
// Omitted from original ten (b-36 eliminates or already covered):
//   - Handle disambiguation: bare handles no longer exist at the MCP boundary.
//   - UUID probing: hard-rejected by assertRefNotUuid in mcp/refs.ts.
//   - Non-member ring (partial): covered by tools-cross-tenant.regression.test.ts.

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
  decisions,
  mcpTokens,
} from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { createTask } from "../services/tasks.js";
import { createDecision } from "../services/decisions.js";
import { createShareToken } from "../services/share-tokens.js";
import { NotFoundError } from "../types/errors.js";
import { app } from "../app.js";

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

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function makeUserOrgMemex(suffix: string) {
  const tag = `adv-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `${tag}@memex.ai` } as never)
    .returning();
  created.users.push(u.id);
  const slug = tag.slice(0, 39);
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

async function addMemex(nsId: string, orgId: string, slug: string, name: string) {
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
    .values({ userId, label: "adv-test", tokenHash, prefix: raw.slice(0, 12) } as never)
    .returning();
  created.tokens.push(tok.id);
  return raw;
}

async function mcpCall(token: string, body: unknown) {
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

function parseResponse(text: string): {
  result?: { content?: Array<{ text: string }>; isError?: boolean };
} {
  // Migration-hint intercept returns plain JSON-RPC; normal tool responses use SSE.
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (dataLine) return JSON.parse(dataLine.slice(6));
  return JSON.parse(text);
}

// ── S1: Concurrent task creation ─────────────────────────────────────────────

describe("S1 — concurrent task creation (withSeqRetry under real concurrency)", () => {
  let owner: Awaited<ReturnType<typeof makeUserOrgMemex>>;
  let token: string;
  let specHandle: string;

  beforeAll(async () => {
    owner = await makeUserOrgMemex("s1-owner");
    token = await mintToken(owner.userId);
    const spec = await createDocDraft(owner.memexId, "S1 Spec", "concurrent task test", "spec");
    specHandle = spec.handle;
  });

  it("five simultaneous create_task calls all succeed with distinct handles", async () => {
    const ref = `${owner.nsSlug}/${owner.memexSlug}/specs/${specHandle}`;
    const calls = Array.from({ length: 5 }, (_, i) =>
      mcpCall(token, {
        jsonrpc: "2.0",
        id: i + 1,
        method: "tools/call",
        params: {
          name: "create_task",
          arguments: { ref, title: `Concurrent task ${i + 1}`, description: "race condition test" },
        },
      }).then(async (res) => {
        const body = parseResponse(await res.text());
        expect(body.result?.isError, `task ${i + 1} failed: ${body.result?.content?.[0]?.text}`).toBeFalsy();
        return body.result?.content?.[0]?.text ?? "";
      }),
    );

    const results = await Promise.all(calls);

    // Extract t-N handle from each response
    const handles = results.map((r) => {
      const match = r.match(/ref:.*\/(t-\d+)/);
      return match?.[1];
    });

    expect(handles.every(Boolean), `Some responses missing handle: ${JSON.stringify(results)}`).toBe(true);
    const unique = new Set(handles);
    expect(unique.size, `Duplicate handles: ${JSON.stringify(handles)}`).toBe(5);
  });
});

// ── S3: Cross-Spec dec-N scoping ────────────────────────────────────────────

describe("S3 — cross-Spec dec-N scoping (dec-1 in two specs, same memex)", () => {
  let owner: Awaited<ReturnType<typeof makeUserOrgMemex>>;
  let token: string;
  let specAHandle: string;
  let specBHandle: string;
  let specAId: string;
  let specBId: string;

  beforeAll(async () => {
    owner = await makeUserOrgMemex("s3-owner");
    token = await mintToken(owner.userId);

    const specA = await createDocDraft(owner.memexId, "Spec A", "s3 test", "spec");
    specAHandle = specA.handle;
    specAId = specA.id;

    const specB = await createDocDraft(owner.memexId, "Spec B", "s3 test", "spec");
    specBHandle = specB.handle;
    specBId = specB.id;

    // Both specs get dec-1 (same seq, different parent doc)
    await createDecision(owner.memexId, specAId, "Decision in A");
    await createDecision(owner.memexId, specBId, "Decision in B");
  });

  it("resolving dec-1 via spec-A path only affects spec-A's decision", async () => {
    const decRef = `${owner.nsSlug}/${owner.memexSlug}/specs/${specAHandle}/decisions/dec-1`;
    const res = await mcpCall(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "resolve_decision",
        arguments: { ref: decRef, resolution: "Resolved in A only" },
      },
    });
    expect(res.status).toBe(200);
    const body = parseResponse(await res.text());
    expect(body.result?.isError).toBeFalsy();

    // Spec-A's dec-1 should be resolved
    const [decA] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.docId, specAId));
    expect(decA.status).toBe("resolved");
    expect(decA.resolution).toBe("Resolved in A only");

    // Spec-B's dec-1 must remain open
    const [decB] = await db
      .select()
      .from(decisions)
      .where(eq(decisions.docId, specBId));
    expect(decB.status).toBe("open");
    expect(decB.resolution).toBeNull();
  });

  it("resolving dec-1 via spec-B path only affects spec-B's decision", async () => {
    const decRef = `${owner.nsSlug}/${owner.memexSlug}/specs/${specBHandle}/decisions/dec-1`;
    const res = await mcpCall(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "resolve_decision",
        arguments: { ref: decRef, resolution: "Resolved in B" },
      },
    });
    expect(res.status).toBe(200);
    const body = parseResponse(await res.text());
    expect(body.result?.isError).toBeFalsy();

    const [decB] = await db.select().from(decisions).where(eq(decisions.docId, specBId));
    expect(decB.status).toBe("resolved");
  });
});

// ── S4: Workspace switching (Carol: memex-A → memex-A2) ──────────────────────

describe("S4 — workspace switching (Carol, memex-A → memex-A2, same org)", () => {
  let owner: Awaited<ReturnType<typeof makeUserOrgMemex>>;
  let memexA2: Awaited<ReturnType<typeof addMemex>>;
  let carol: { userId: string };
  let carolToken: string;

  beforeAll(async () => {
    owner = await makeUserOrgMemex("s4-owner");
    memexA2 = await addMemex(owner.nsId, owner.orgId, "second", "S4 memex-A2");

    const tag = `s4-carol-${Date.now().toString(36)}`;
    const [carolUser] = await db
      .insert(users)
      .values({ email: `${tag}@memex.ai` } as never)
      .returning();
    created.users.push(carolUser.id);
    carol = { userId: carolUser.id };
    await db.insert(orgMemberships).values({ userId: carol.userId, orgId: owner.orgId, role: "member" } as never);
    carolToken = await mintToken(carol.userId);
  });

  it("Carol can create_doc in memex-A then create_doc in memex-A2 — both succeed", async () => {
    const resA = await mcpCall(carolToken, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "create_doc",
        arguments: { memex: `${owner.nsSlug}/${owner.memexSlug}`, title: "Carol's doc in A", purpose: "s4 test" },
      },
    });
    const bodyA = parseResponse(await resA.text());
    expect(bodyA.result?.isError, `memex-A call failed: ${bodyA.result?.content?.[0]?.text}`).toBeFalsy();

    const resA2 = await mcpCall(carolToken, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: {
        name: "create_doc",
        arguments: { memex: `${owner.nsSlug}/${memexA2.memexSlug}`, title: "Carol's doc in A2", purpose: "s4 test" },
      },
    });
    const bodyA2 = parseResponse(await resA2.text());
    expect(bodyA2.result?.isError, `memex-A2 call failed: ${bodyA2.result?.content?.[0]?.text}`).toBeFalsy();
  });

  it("docs created in memex-A do not appear in memex-A2 and vice versa", async () => {
    const { documents: docsTable } = await import("../db/schema.js");
    const docsInA = await db.select().from(docsTable).where(eq(docsTable.memexId, owner.memexId));
    const docsInA2 = await db.select().from(docsTable).where(eq(docsTable.memexId, memexA2.memexId));

    const aIds = new Set(docsInA.map((d) => d.id));
    const a2Ids = new Set(docsInA2.map((d) => d.id));

    // No doc appears in both memexes
    for (const id of aIds) {
      expect(a2Ids.has(id), `Doc ${id} leaked from memex-A into memex-A2`).toBe(false);
    }
  });
});

// ── S9: REST memexId tamper (service layer) ───────────────────────────────────

describe("S9 — REST memexId tamper (createTask with foreign docId → NotFoundError)", () => {
  let alice: Awaited<ReturnType<typeof makeUserOrgMemex>>;
  let bob: Awaited<ReturnType<typeof makeUserOrgMemex>>;
  let bobSpecId: string;

  beforeAll(async () => {
    alice = await makeUserOrgMemex("s9-alice");
    bob = await makeUserOrgMemex("s9-bob");
    const spec = await createDocDraft(bob.memexId, "Bob's spec", "s9 test", "spec");
    bobSpecId = spec.id;
  });

  it("createTask(alice.memexId, bob.docId) throws NotFoundError — service enforces path-scoped memex", async () => {
    await expect(
      createTask(alice.memexId, bobSpecId, "Alice tamper task", "should never land"),
    ).rejects.toThrow(NotFoundError);
  });

  it("Bob's spec task count is unchanged after the rejected call", async () => {
    const { tasks: tasksTable } = await import("../db/schema.js");
    const tasksBefore = await db.select().from(tasksTable).where(eq(tasksTable.memexId, bob.memexId));
    // Attempt again (already confirmed it throws)
    await createTask(alice.memexId, bobSpecId, "Another tamper attempt", "noop").catch(() => {});
    const tasksAfter = await db.select().from(tasksTable).where(eq(tasksTable.memexId, bob.memexId));
    expect(tasksAfter.length).toBe(tasksBefore.length);
  });
});

// ── S10: Stale-config replay / migration hint ─────────────────────────────────

describe("S10 — stale-config replay (old arg names return structured migration hint)", () => {
  let owner: Awaited<ReturnType<typeof makeUserOrgMemex>>;
  let token: string;

  beforeAll(async () => {
    owner = await makeUserOrgMemex("s10-owner");
    token = await mintToken(owner.userId);
  });

  it("update_doc with {docId} instead of {ref} returns a structured migration hint", async () => {
    const res = await mcpCall(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "update_doc",
        arguments: { docId: "00000000-0000-0000-0000-000000000001", title: "stale call" },
      },
    });
    expect(res.status).toBe(200);
    const body = parseResponse(await res.text());
    expect(body.result?.isError).toBe(true);
    const msg = body.result?.content?.[0]?.text ?? "";
    // Must reference the old field name and the b-36 canonical-ref form
    expect(msg, `Migration hint missing 'docId': ${msg}`).toContain("docId");
    expect(msg.toLowerCase(), `Migration hint missing b-36/canonical reference: ${msg}`).toMatch(/b-36|canonical/);
    // Must reference the replacement field
    expect(msg, `Migration hint missing 'ref': ${msg}`).toContain("ref");
  });

  it("update_task with {taskId} instead of {ref} returns a structured migration hint", async () => {
    const res = await mcpCall(token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "update_task",
        arguments: { taskId: "00000000-0000-0000-0000-000000000002", status: "complete" },
      },
    });
    expect(res.status).toBe(200);
    const body = parseResponse(await res.text());
    expect(body.result?.isError).toBe(true);
    const msg = body.result?.content?.[0]?.text ?? "";
    expect(msg).toContain("taskId");
    expect(msg.toLowerCase()).toMatch(/b-36|canonical/);
    expect(msg).toContain("ref");
  });
});

// ── S-share: Share-token scope ────────────────────────────────────────────────

describe("S-share — share-token scope (token is bound to a specific doc)", () => {
  let alice: Awaited<ReturnType<typeof makeUserOrgMemex>>;
  let bob: Awaited<ReturnType<typeof makeUserOrgMemex>>;
  let docAToken: string;
  let docBTitle: string;

  beforeAll(async () => {
    alice = await makeUserOrgMemex("sshare-alice");
    bob = await makeUserOrgMemex("sshare-bob");

    const docA = await createDocDraft(alice.memexId, "Alice's shared doc", "for share test", "spec");
    docBTitle = "Bob's private doc";
    await createDocDraft(bob.memexId, docBTitle, "not shared", "spec");

    const tokenRow = await createShareToken(alice.memexId, docA.id);
    docAToken = tokenRow.token;
  });

  it("GET /api/share/<token> returns the correct doc (200)", async () => {
    const res = await app.request(`/api/share/${docAToken}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json() as { doc?: { title?: string } };
    expect(body.doc?.title).toBe("Alice's shared doc");
  });

  it("GET /api/share/<token> does NOT expose Bob's doc title", async () => {
    const res = await app.request(`/api/share/${docAToken}`, { method: "GET" });
    const text = await res.text();
    expect(text).not.toContain(docBTitle);
  });

  it("GET /api/share/<fabricated-token> returns 404", async () => {
    const fakeToken = `00000000-fake-fake-fake-000000000000`;
    const res = await app.request(`/api/share/${fakeToken}`, { method: "GET" });
    expect(res.status).toBe(404);
  });
});
