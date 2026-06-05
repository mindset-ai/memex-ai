import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
} from "../db/schema.js";
import {
  resolveWorkspace,
  resolveMemexFromEntity,
  resolveMemexFromDocRef,
  assertMembership,
  isUuid,
  McpAuthError,
} from "./auth.js";

const created = {
  users: [] as string[],
  memexes: [] as string[],
};

afterAll(async () => {
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
});

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
