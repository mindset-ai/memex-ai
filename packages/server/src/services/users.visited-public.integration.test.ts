import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  users,
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  userMemexAccess,
} from "../db/schema.js";
import { tagAc } from "@memex-ai-ac/vitest";
import { listMemberships, recordPublicMemexVisit, upsertUserByEmail } from "./users.js";

// spec-111 t-6 — Memex list joins user_memex_access (visited public memexes) and
// the insert-on-visit (recordPublicMemexVisit). Covers ac-9: a signed-in
// NON-member visiting a public memex auto-adds it to their Memex list with a
// read-only / "Visited" marker, without duplicating on repeat visits, and
// without disturbing org members' results.
const AC = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-9";
// spec-111 t-8 wiring (ac-4): the Memex's own visibility rides on every
// membership row so the React header can light the 🌐 public badge without a
// second fetch.
const AC_VISIBILITY = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-4";

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    // userMemexAccess rows cascade on user delete; clear explicitly too in case
    // a memex is the cascade root instead.
    await db.delete(userMemexAccess).where(inArray(userMemexAccess.userId, createdUserIds)).catch(() => {});
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdMemexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
}

// Seed an org-owned memex with the given visibility. Returns the memex + org so
// callers can add memberships or visit it as a non-member.
async function seedOrgMemex(opts: { name: string; visibility: "public" | "private" }) {
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: uniqueSlug("ns"), kind: "org" })
    .returning();
  createdNamespaceIds.push(ns.id);
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: opts.name, emailDomains: [] })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [memex] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: opts.name, visibility: opts.visibility })
    .returning();
  createdMemexIds.push(memex.id);
  return { memex, org, namespace: ns };
}

async function seedUser(prefix: string) {
  const user = await upsertUserByEmail(uniqueEmail(prefix));
  createdUserIds.push(user.id);
  return user;
}

describe("recordPublicMemexVisit + listMemberships (spec-111 t-6 — Visited public memexes)", () => {
  it("insert-on-visit adds exactly one user_memex_access row for a non-member", async () => {
    tagAc(AC);

    const visitor = await seedUser("visitor");
    const { memex } = await seedOrgMemex({ name: "Public Co", visibility: "public" });

    const result = await recordPublicMemexVisit(visitor.id, memex.id);
    expect(result.inserted).toBe(true);

    const rows = await db
      .select()
      .from(userMemexAccess)
      .where(and(eq(userMemexAccess.userId, visitor.id), eq(userMemexAccess.memexId, memex.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].accessLevel).toBe("read");
  });

  it("repeat visit does NOT duplicate the row (ON CONFLICT DO NOTHING)", async () => {
    tagAc(AC);

    const visitor = await seedUser("revisitor");
    const { memex } = await seedOrgMemex({ name: "Repeat Co", visibility: "public" });

    const first = await recordPublicMemexVisit(visitor.id, memex.id);
    const second = await recordPublicMemexVisit(visitor.id, memex.id);
    const third = await recordPublicMemexVisit(visitor.id, memex.id);

    expect(first.inserted).toBe(true);
    // Re-visits are conflict no-ops: nothing new inserted.
    expect(second.inserted).toBe(false);
    expect(third.inserted).toBe(false);

    const rows = await db
      .select()
      .from(userMemexAccess)
      .where(and(eq(userMemexAccess.userId, visitor.id), eq(userMemexAccess.memexId, memex.id)));
    expect(rows).toHaveLength(1);
  });

  it("listMemberships returns the visited public memex flagged read-only / Visited", async () => {
    tagAc(AC);

    const visitor = await seedUser("lister");
    const { memex } = await seedOrgMemex({ name: "Visited Co", visibility: "public" });

    // Before the visit, the non-member sees nothing for this memex.
    const before = await listMemberships(visitor.id);
    expect(before.find((m) => m.memexId === memex.id)).toBeUndefined();

    await recordPublicMemexVisit(visitor.id, memex.id);

    const after = await listMemberships(visitor.id);
    const entry = after.find((m) => m.memexId === memex.id);
    expect(entry).toBeDefined();
    // The load-bearing read-only signal: source='visited', accessLevel='read'.
    expect(entry?.source).toBe("visited");
    expect(entry?.accessLevel).toBe("read");
    expect(entry?.name).toBe("Visited Co");
  });

  it("org members' results are unchanged — full-access, never tagged visited", async () => {
    tagAc(AC);

    const member = await seedUser("member");
    const { memex, org } = await seedOrgMemex({ name: "Member Co", visibility: "public" });

    await db.insert(orgMemberships).values({
      userId: member.id,
      orgId: org.id,
      role: "administrator",
    });

    const memberships = await listMemberships(member.id);
    const entry = memberships.find((m) => m.memexId === memex.id);
    expect(entry).toBeDefined();
    // An org member's row is full-access regardless of the memex being public.
    expect(entry?.source).toBe("org");
    expect(entry?.accessLevel).toBe("write");
    expect(entry?.role).toBe("administrator");
    // Exactly one row for this memex — no duplicate "Visited" entry even if a
    // stale pin existed.
    expect(memberships.filter((m) => m.memexId === memex.id)).toHaveLength(1);
  });

  it("listMemberships carries the Memex visibility on the org-member row (ac-4 — header badge)", async () => {
    tagAc(AC_VISIBILITY);

    const member = await seedUser("vis-member");
    const { memex, org } = await seedOrgMemex({ name: "Public Badge Co", visibility: "public" });
    await db.insert(orgMemberships).values({
      userId: member.id,
      orgId: org.id,
      role: "administrator",
    });

    const memberships = await listMemberships(member.id);
    const entry = memberships.find((m) => m.memexId === memex.id);
    expect(entry).toBeDefined();
    // The visibility column rides on the row — this is what lights the 🌐 badge.
    expect(entry?.visibility).toBe("public");
  });

  it("listMemberships carries 'private' visibility on a private org Memex (no badge)", async () => {
    tagAc(AC_VISIBILITY);

    const member = await seedUser("vis-priv-member");
    const { memex, org } = await seedOrgMemex({ name: "Private Co", visibility: "private" });
    await db.insert(orgMemberships).values({
      userId: member.id,
      orgId: org.id,
      role: "member",
    });

    const memberships = await listMemberships(member.id);
    const entry = memberships.find((m) => m.memexId === memex.id);
    expect(entry?.visibility).toBe("private");
  });

  it("listMemberships carries visibility on the visited (read-only) row (ac-4)", async () => {
    tagAc(AC_VISIBILITY);

    const visitor = await seedUser("vis-visitor");
    const { memex } = await seedOrgMemex({ name: "Visited Public Co", visibility: "public" });
    await recordPublicMemexVisit(visitor.id, memex.id);

    const memberships = await listMemberships(visitor.id);
    const entry = memberships.find((m) => m.memexId === memex.id);
    expect(entry?.source).toBe("visited");
    expect(entry?.visibility).toBe("public");
  });

  it("a member who also has a stale visited pin sees the memex once, as org (no duplicate)", async () => {
    tagAc(AC);

    const member = await seedUser("dualmember");
    const { memex, org } = await seedOrgMemex({ name: "Dual Co", visibility: "public" });

    // Visit first (as if they were a non-member), THEN gain membership.
    await recordPublicMemexVisit(member.id, memex.id);
    await db.insert(orgMemberships).values({
      userId: member.id,
      orgId: org.id,
      role: "member",
    });

    const memberships = await listMemberships(member.id);
    const matches = memberships.filter((m) => m.memexId === memex.id);
    expect(matches).toHaveLength(1);
    // Org membership wins — the org row is surfaced, the visited pin suppressed.
    expect(matches[0].source).toBe("org");
    expect(matches[0].accessLevel).toBe("write");
  });
});
