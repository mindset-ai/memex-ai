import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
  users,
  mcpSessions,
  mcpToolCalls,
} from "../db/schema.js";
import {
  resolveWorkspace,
  resolveWorkspaceForRead,
  resolveMemexFromEntity,
  resolveMemexFromDocRef,
  assertMembership,
  isUuid,
  McpAuthError,
} from "./auth.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-471/acs";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  sessions: [] as string[],
};

afterAll(async () => {
  if (created.sessions.length) {
    // tool_calls cascade on session delete (FK onDelete cascade).
    await db.delete(mcpSessions).where(inArray(mcpSessions.sessionId, created.sessions)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
});

// Records an MCP tool call for `userId` against `memexId` at `at`, so the read-path
// fallback (spec-471 dec-1 #3) has a "most-recently-active memex" to derive.
async function recordToolCall(userId: string, memexId: string | null, at: Date) {
  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(mcpSessions).values({ sessionId, userId } as any);
  created.sessions.push(sessionId);
  await db
    .insert(mcpToolCalls)
    .values({ sessionId, userId, memexId, toolName: "search_memex", argsJson: {}, durationMs: 0, createdAt: at } as any);
}

async function makeUser(suffix: string) {
  const [u] = await db
    .insert(users)
    .values({ email: `mcp-auth-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  return u;
}

async function makeAccount(sub: string): Promise<{ id: string; slug: string; orgId: string }> {
  const slug = `${sub}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 39);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: sub }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db
    .insert(memexes)
    .values({ name: sub, slug: "main", namespaceId: ns.id })
    .returning();
  created.memexes.push(a.id);
  return { id: a.id, slug: ns.slug, orgId: org.id };
}

async function addMember(userId: string, memexId: string, role: "member" | "administrator" = "member") {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) return;
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, memex.namespaceId) });
  if (!ns?.ownerOrgId) return;
  await db.insert(orgMemberships).values({ userId, orgId: ns.ownerOrgId, role });
}

describe("isUuid", () => {
  it("accepts canonical UUIDs", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
  it("rejects handles like doc-1", () => {
    expect(isUuid("doc-1")).toBe(false);
    expect(isUuid("dec-23")).toBe(false);
    expect(isUuid("t-7")).toBe(false);
  });
});

describe("resolveWorkspace", () => {
  it("uses the user's only workspace when arg is omitted", async () => {
    const u = await makeUser("rw-one");
    const a = await makeAccount("rw-one");
    await addMember(u.id, a.id);

    const memexId = await resolveWorkspace(u.id, undefined);
    expect(memexId).toBe(a.id);
  });

  it("throws when user has no workspaces", async () => {
    const u = await makeUser("rw-none");
    await expect(resolveWorkspace(u.id, undefined)).rejects.toThrow(McpAuthError);
  });

  it("throws (with subdomains listed) when multi-workspace and no arg", async () => {
    const u = await makeUser("rw-multi");
    const a1 = await makeAccount("rw-m1");
    const a2 = await makeAccount("rw-m2");
    await addMember(u.id, a1.id);
    await addMember(u.id, a2.id);

    await expect(resolveWorkspace(u.id, undefined)).rejects.toThrow(/Multiple Memexes/);
  });

  // b-42 t-3 — bare-namespace form (no `/`) is no longer accepted. Pre-fix, it
  // auto-resolved when the namespace contained exactly one memex; the moment a
  // 2nd memex was added every prior caller broke at once with "Ambiguous". Now
  // we reject up-front and force the caller to use the explicit slash form.
  it("rejects bare-namespace form with a structured error (b-42 t-3)", async () => {
    const u = await makeUser("rw-sub");
    const a = await makeAccount("rw-sub");
    await addMember(u.id, a.id);

    await expect(resolveWorkspace(u.id, a.slug)).rejects.toThrow(McpAuthError);
    await expect(resolveWorkspace(u.id, a.slug)).rejects.toThrow(
      /<namespace>\/<memex>/,
    );
  });

  it("rejects bare-namespace form case-insensitively (b-42 t-3)", async () => {
    const u = await makeUser("rw-sub-upper");
    const a = await makeAccount("rw-sub-upper");
    await addMember(u.id, a.id);

    await expect(
      resolveWorkspace(u.id, a.slug.toUpperCase()),
    ).rejects.toThrow(/<namespace>\/<memex>/);
  });

  it("looks up by UUID", async () => {
    const u = await makeUser("rw-uuid");
    const a = await makeAccount("rw-uuid");
    await addMember(u.id, a.id);

    const memexId = await resolveWorkspace(u.id, a.id);
    expect(memexId).toBe(a.id);
  });

  it("403s when user is not a member of the requested workspace", async () => {
    const u = await makeUser("rw-nope");
    const a = await makeAccount("rw-nope");
    // user is not added as member

    await expect(
      resolveWorkspace(u.id, `${a.slug}/main`),
    ).rejects.toThrow(/not a member/);
  });

  it("404s when namespace doesn't exist", async () => {
    const u = await makeUser("rw-missing");
    await expect(
      resolveWorkspace(u.id, "no-such-workspace-xyz/main"),
    ).rejects.toThrow(/not found/);
  });

  // t-22 of doc-15 — `<namespace>/<memex>` slash-form per F.5.
  it("resolves `<namespace>/<memex>` slash form", async () => {
    const u = await makeUser("rw-slash");
    const a = await makeAccount("rw-slash");
    await addMember(u.id, a.id);

    const memexId = await resolveWorkspace(u.id, `${a.slug}/main`);
    expect(memexId).toBe(a.id);
  });

  it("rejects an unknown memex within a known namespace (slash form)", async () => {
    const u = await makeUser("rw-bad-mx");
    const a = await makeAccount("rw-bad-mx");
    await addMember(u.id, a.id);

    await expect(
      resolveWorkspace(u.id, `${a.slug}/no-such-memex`),
    ).rejects.toThrow(/not found/);
  });

  it("errors with `<namespace>/<memex>` form prompt when namespace has multiple memexes", async () => {
    const u = await makeUser("rw-amb");
    const a = await makeAccount("rw-amb");
    await addMember(u.id, a.id);
    // Add a second memex to the same namespace so the bare slug is ambiguous.
    const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, a.id) });
    if (!memex) throw new Error("test setup");
    await db
      .insert(memexes)
      .values({
        name: "extra",
        slug: "extra",
        namespaceId: memex.namespaceId,
      } as any)
      .returning();

    await expect(resolveWorkspace(u.id, a.slug)).rejects.toThrow(
      /Ambiguous|<namespace>\/<memex>/,
    );
  });

  it("rejects malformed slash form (trailing slash)", async () => {
    const u = await makeUser("rw-malformed");
    await expect(resolveWorkspace(u.id, "mindset/")).rejects.toThrow(
      /Invalid memex identifier|not found/,
    );
  });

  it("rejects slash form with multiple slashes", async () => {
    const u = await makeUser("rw-multi-slash");
    await expect(resolveWorkspace(u.id, "a/b/c")).rejects.toThrow(/Invalid memex identifier/);
  });

  it("error message when multi-namespace user passes no arg lists `<namespace>/<memex>` ids", async () => {
    const u = await makeUser("rw-multi-ns");
    const a1 = await makeAccount("rw-mn1");
    const a2 = await makeAccount("rw-mn2");
    await addMember(u.id, a1.id);
    await addMember(u.id, a2.id);
    // The error string must include the slash-form identifiers — verifies F.5.
    await expect(resolveWorkspace(u.id, undefined)).rejects.toThrow(
      /<namespace>\/<memex>/,
    );
  });
});

// spec-471 t-1: no-arg READ path defaults to the caller's most-recently-active
// memex (dec-1 #3), while the no-arg WRITE path keeps the hard error (dec-2 A).
describe("resolveWorkspaceForRead — no-arg default (spec-471)", () => {
  it("multi-workspace no-arg read resolves to the most-recently-used memex", async () => {
    tagAc(`${AC}/ac-2`);
    tagAc(`${AC}/ac-6`); // scope outcome: kills the #1 auth error on the read path

    const u = await makeUser("s471-read-recent");
    const a = await makeAccount("s471-a");
    const b = await makeAccount("s471-b");
    await addMember(u.id, a.id);
    await addMember(u.id, b.id);
    // a used first, b used most recently → b is the expected default.
    await recordToolCall(u.id, a.id, new Date(Date.now() - 60_000));
    await recordToolCall(u.id, b.id, new Date(Date.now() - 1_000));

    const { memexId } = await resolveWorkspaceForRead(u.id, undefined);
    expect(memexId).toBe(b.id);
  });

  it("multi-workspace no-arg read with NO history still hard-errors", async () => {
    tagAc(`${AC}/ac-3`);
    const u = await makeUser("s471-read-nohist");
    const a = await makeAccount("s471-nh-a");
    const b = await makeAccount("s471-nh-b");
    await addMember(u.id, a.id);
    await addMember(u.id, b.id);
    // No recordToolCall → nothing to default to.
    await expect(resolveWorkspaceForRead(u.id, undefined)).rejects.toThrow(
      /Multiple Memexes/,
    );
  });

  it("ignores history for a memex the user is no longer a member of", async () => {
    tagAc(`${AC}/ac-2`);
    const u = await makeUser("s471-read-stale");
    const a = await makeAccount("s471-stale-a");
    const b = await makeAccount("s471-stale-b");
    const gone = await makeAccount("s471-stale-gone");
    await addMember(u.id, a.id);
    await addMember(u.id, b.id);
    // Most-recent call is against a memex the user does NOT belong to — must be
    // skipped in favour of the most recent one they can still access (a).
    await recordToolCall(u.id, a.id, new Date(Date.now() - 60_000));
    await recordToolCall(u.id, gone.id, new Date(Date.now() - 1_000));

    const { memexId } = await resolveWorkspaceForRead(u.id, undefined);
    expect(memexId).toBe(a.id);
  });

  it("WRITE path still hard-errors even when read history exists (std-5 guard)", async () => {
    tagAc(`${AC}/ac-1`);
    tagAc(`${AC}/ac-7`); // scope outcome: no write ever silently defaulted

    const u = await makeUser("s471-write-guard");
    const a = await makeAccount("s471-w-a");
    const b = await makeAccount("s471-w-b");
    await addMember(u.id, a.id);
    await addMember(u.id, b.id);
    await recordToolCall(u.id, b.id, new Date());
    // The write entrypoint must NOT auto-pick — no silent wrong-workspace write.
    await expect(resolveWorkspace(u.id, undefined)).rejects.toThrow(/Multiple Memexes/);
  });

  it("no regression: single-workspace read auto-resolves; explicit memex= resolves", async () => {
    tagAc(`${AC}/ac-4`);
    const u = await makeUser("s471-noregress");
    const a = await makeAccount("s471-nr-a");
    await addMember(u.id, a.id);
    // Single workspace → resolves with no arg, no error, no history needed.
    const solo = await resolveWorkspaceForRead(u.id, undefined);
    expect(solo.memexId).toBe(a.id);
    // Explicit slash form still resolves exactly as before.
    const explicit = await resolveWorkspaceForRead(u.id, `${a.slug}/main`);
    expect(explicit.memexId).toBe(a.id);
  });
});

describe("resolveMemexFromEntity", () => {
  it("rejects non-UUID ids with a helpful message", async () => {
    const u = await makeUser("rae-handle");
    await expect(resolveMemexFromEntity(u.id, "doc", "doc-1")).rejects.toThrow(/UUID/);
  });

  it("resolves doc → account and asserts membership", async () => {
    const u = await makeUser("rae-doc");
    const a = await makeAccount("rae-doc");
    await addMember(u.id, a.id);
    const [doc] = await db
      .insert(documents)
      .values({ memexId: a.id, handle: "doc-1", title: "x" })
      .returning();

    const got = await resolveMemexFromEntity(u.id, "doc", doc.id);
    expect(got).toBe(a.id);
  });

  it("forbids when user is not a member of the doc's account", async () => {
    const stranger = await makeUser("rae-stranger");
    const owner = await makeUser("rae-owner");
    const a = await makeAccount("rae-forbid");
    await addMember(owner.id, a.id);
    const [doc] = await db
      .insert(documents)
      .values({ memexId: a.id, handle: "doc-1", title: "x" })
      .returning();

    await expect(resolveMemexFromEntity(stranger.id, "doc", doc.id)).rejects.toThrow(/not a member/);
  });

  it("resolves section → doc → account", async () => {
    const u = await makeUser("rae-sec");
    const a = await makeAccount("rae-sec");
    await addMember(u.id, a.id);
    const [doc] = await db
      .insert(documents)
      .values({ memexId: a.id, handle: "doc-1", title: "x" })
      .returning();
    const [section] = await db
      .insert(docSections)
      .values({ docId: doc.id, sectionType: "purpose", content: "x", seq: 1, position: 1 } as any)
      .returning();

    const got = await resolveMemexFromEntity(u.id, "section", section.id);
    expect(got).toBe(a.id);
  });

  it("resolves decision → account", async () => {
    const u = await makeUser("rae-dec");
    const a = await makeAccount("rae-dec");
    await addMember(u.id, a.id);
    const [doc] = await db
      .insert(documents)
      .values({ memexId: a.id, handle: "doc-1", title: "x" })
      .returning();
    const [dec] = await db
      .insert(decisions)
      .values({ memexId: a.id, docId: doc.id, seq: 1, title: "?" })
      .returning();

    const got = await resolveMemexFromEntity(u.id, "decision", dec.id);
    expect(got).toBe(a.id);
  });

  it("resolves task → account", async () => {
    const u = await makeUser("rae-task");
    const a = await makeAccount("rae-task");
    await addMember(u.id, a.id);
    const [doc] = await db
      .insert(documents)
      .values({ memexId: a.id, handle: "doc-1", title: "x" })
      .returning();
    const [t] = await db
      .insert(tasks)
      .values({ memexId: a.id, docId: doc.id, seq: 1, title: "x", description: "y" })
      .returning();

    const got = await resolveMemexFromEntity(u.id, "task", t.id);
    expect(got).toBe(a.id);
  });

  it("resolves comment → account", async () => {
    const u = await makeUser("rae-cmt");
    const a = await makeAccount("rae-cmt");
    await addMember(u.id, a.id);
    const [doc] = await db
      .insert(documents)
      .values({ memexId: a.id, handle: "doc-1", title: "x" })
      .returning();
    const [s] = await db
      .insert(docSections)
      .values({ docId: doc.id, sectionType: "purpose", content: "x", seq: 1, position: 1 } as any)
      .returning();
    const [cmt] = await db
      .insert(docComments)
      .values({ memexId: a.id, docId: doc.id, seq: 1, sectionId: s.id, authorName: "alice", content: "hi" })
      .returning();

    const got = await resolveMemexFromEntity(u.id, "comment", cmt.id);
    expect(got).toBe(a.id);
  });

  it("404s when entity doesn't exist", async () => {
    const u = await makeUser("rae-404");
    await expect(
      resolveMemexFromEntity(u.id, "doc", "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveMemexFromDocRef", () => {
  it("treats a UUID as an entity reference", async () => {
    const u = await makeUser("dref-uuid");
    const a = await makeAccount("dref-uuid");
    await addMember(u.id, a.id);
    const [doc] = await db
      .insert(documents)
      .values({ memexId: a.id, handle: "doc-1", title: "x" })
      .returning();

    const got = await resolveMemexFromDocRef(u.id, doc.id, undefined);
    expect(got).toBe(a.id);
  });

  it("requires workspace when given a handle", async () => {
    const u = await makeUser("dref-handle");
    await expect(resolveMemexFromDocRef(u.id, "doc-1", undefined)).rejects.toThrow(
      /handle/i
    );
  });

  it("resolves handle via workspace arg", async () => {
    const u = await makeUser("dref-with-ws");
    const a = await makeAccount("dref-with-ws");
    await addMember(u.id, a.id);

    // Slash form required post b-42 t-3 (bare-namespace no longer accepted).
    const got = await resolveMemexFromDocRef(u.id, "doc-1", `${a.slug}/main`);
    expect(got).toBe(a.id);
  });
});

describe("assertMembership", () => {
  it("passes for active members", async () => {
    const u = await makeUser("am-active");
    const a = await makeAccount("am-active");
    await addMember(u.id, a.id);
    await expect(assertMembership(u.id, a.id)).resolves.toBeUndefined();
  });

  it("throws for non-members", async () => {
    const u = await makeUser("am-no");
    const a = await makeAccount("am-no");
    await expect(assertMembership(u.id, a.id)).rejects.toThrow(/not a member/);
  });
});
