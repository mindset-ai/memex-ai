// spec-111 t-2 — read/write authz split.
//
// Verifies canReadMemex / canWriteMemex against a real Postgres. Covers ac-3:
// org members retain full read+write on BOTH public and private memexes
// (unchanged from the pre-spec-111 membership model), while non-members and
// anonymous callers get the looser read gate on public memexes only.
//
// Tagged to mindset-prod/memex-building-itself/specs/spec-111/acs/ac-3.

import { describe, it, expect, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, users } from "../db/schema.js";
import { canReadMemex, canWriteMemex, assertMembership, McpAuthError } from "./auth.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_3 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-3";

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
    .values({
      email: `auth-vis-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@memex.ai`,
    } as any)
    .returning();
  created.users.push(u.id);
  return u;
}

// Creates an org namespace + org + one memex with the requested visibility.
async function makeAccount(
  sub: string,
  visibility: "public" | "private",
): Promise<{ id: string; slug: string; orgId: string }> {
  const slug = `${sub}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .toLowerCase()
    .slice(0, 39);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: sub }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db
    .insert(memexes)
    .values({ name: sub, slug: "main", namespaceId: ns.id, visibility })
    .returning();
  created.memexes.push(a.id);
  return { id: a.id, slug: ns.slug, orgId: org.id };
}

async function addMember(userId: string, orgId: string, role: "member" | "administrator" = "member") {
  await db.insert(orgMemberships).values({ userId, orgId, role });
}

describe("spec-111 read/write authz split", () => {
  describe("org member — full read+write on public AND private (unchanged, ac-3)", () => {
    it("public memex: org member canRead && canWrite", async () => {
      tagAc(AC_3);
      const u = await makeUser("member-pub");
      const a = await makeAccount("member-pub", "public");
      await addMember(u.id, a.orgId);

      expect(await canReadMemex(u.id, a.id)).toBe(true);
      expect(await canWriteMemex(u.id, a.id)).toBe(true);
    });

    it("private memex: org member canRead && canWrite", async () => {
      tagAc(AC_3);
      const u = await makeUser("member-priv");
      const a = await makeAccount("member-priv", "private");
      await addMember(u.id, a.orgId);

      expect(await canReadMemex(u.id, a.id)).toBe(true);
      expect(await canWriteMemex(u.id, a.id)).toBe(true);
    });

    it("private memex: org member still passes the throwing membership gate", async () => {
      tagAc(AC_3);
      const u = await makeUser("member-assert");
      const a = await makeAccount("member-assert", "private");
      await addMember(u.id, a.orgId);

      await expect(assertMembership(u.id, a.id)).resolves.toBeUndefined();
    });
  });

  describe("non-member — read public only, never write (ac-3)", () => {
    it("public memex: non-member canRead true", async () => {
      tagAc(AC_3);
      const u = await makeUser("nonmember-pub-read");
      const a = await makeAccount("nonmember-pub-read", "public");
      // intentionally NOT added as a member

      expect(await canReadMemex(u.id, a.id)).toBe(true);
    });

    it("public memex: non-member canWrite false", async () => {
      tagAc(AC_3);
      const u = await makeUser("nonmember-pub-write");
      const a = await makeAccount("nonmember-pub-write", "public");

      expect(await canWriteMemex(u.id, a.id)).toBe(false);
    });

    it("private memex: non-member canRead false", async () => {
      tagAc(AC_3);
      const u = await makeUser("nonmember-priv-read");
      const a = await makeAccount("nonmember-priv-read", "private");

      expect(await canReadMemex(u.id, a.id)).toBe(false);
    });

    it("private memex: non-member canWrite false", async () => {
      tagAc(AC_3);
      const u = await makeUser("nonmember-priv-write");
      const a = await makeAccount("nonmember-priv-write", "private");

      expect(await canWriteMemex(u.id, a.id)).toBe(false);
    });

    it("private memex: non-member trips the std-7 throwing gate", async () => {
      tagAc(AC_3);
      const u = await makeUser("nonmember-priv-assert");
      const a = await makeAccount("nonmember-priv-assert", "private");

      await expect(assertMembership(u.id, a.id)).rejects.toThrow(McpAuthError);
      await expect(assertMembership(u.id, a.id)).rejects.toThrow(/not a member/);
    });
  });

  describe("anonymous (userId null) — read public only (ac-3)", () => {
    it("public memex: anonymous canRead true", async () => {
      tagAc(AC_3);
      const a = await makeAccount("anon-pub", "public");

      expect(await canReadMemex(null, a.id)).toBe(true);
    });

    it("private memex: anonymous canRead false", async () => {
      tagAc(AC_3);
      const a = await makeAccount("anon-priv", "private");

      expect(await canReadMemex(null, a.id)).toBe(false);
    });
  });

  describe("org resolved via memexes.namespaceId → namespaces.orgId (ac-3)", () => {
    it("a member of a DIFFERENT org cannot write or read a private memex", async () => {
      tagAc(AC_3);
      const u = await makeUser("other-org-member");
      const other = await makeAccount("other-org", "private");
      const target = await makeAccount("target-org", "private");
      // user is a member of `other`, not `target`
      await addMember(u.id, other.orgId);

      expect(await canWriteMemex(u.id, target.id)).toBe(false);
      expect(await canReadMemex(u.id, target.id)).toBe(false);
    });
  });
});
