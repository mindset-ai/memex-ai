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
import { setFeaturedDemo } from "./memexes.js";

// spec-500 — the "featured demo" channel in listMemberships surfaces a
// public + is_featured_demo memex read-only in EVERY authenticated user's
// switcher ("Explore" group), without membership or a prior visit.
const AC_COLUMN = "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-9";
const AC_APPEARS = "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-10";
const AC_DEDUP = "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-11";
const AC_READONLY = "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-12";
// ac-14 (dec-8): the mechanism is a flag flipped on an EXISTING memex row —
// setFeaturedDemo turns any existing memex into the featured entry; no new
// memex/org/seed is created.
const AC_EXISTING_ROW = "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-14";

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
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

// Seed an org-owned memex with the given visibility + featured flag. Returns the
// memex + org so callers can add memberships or visit it as a non-member.
async function seedMemex(opts: {
  name: string;
  visibility: "public" | "private";
  isFeaturedDemo: boolean;
}) {
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
    .values({
      namespaceId: ns.id,
      slug: "main",
      name: opts.name,
      visibility: opts.visibility,
      isFeaturedDemo: opts.isFeaturedDemo,
    })
    .returning();
  createdMemexIds.push(memex.id);
  return { memex, org, namespace: ns };
}

async function seedUser(prefix: string) {
  const user = await upsertUserByEmail(uniqueEmail(prefix));
  createdUserIds.push(user.id);
  return user;
}

describe("listMemberships — featured demo channel (spec-500)", () => {
  it("the memexes table has the is_featured_demo column, defaulting false (ac-9)", async () => {
    tagAc(AC_COLUMN);

    // Insert WITHOUT specifying the flag — the NOT NULL DEFAULT false must apply.
    const { memex } = await seedMemex({ name: "Default Co", visibility: "private", isFeaturedDemo: false });
    const [row] = await db
      .select({ isFeaturedDemo: memexes.isFeaturedDemo })
      .from(memexes)
      .where(eq(memexes.id, memex.id));
    expect(row.isFeaturedDemo).toBe(false);
  });

  it("a public + featured memex appears for a non-member who never visited it (ac-10)", async () => {
    tagAc(AC_APPEARS);

    const user = await seedUser("explorer");
    const { memex } = await seedMemex({ name: "Explore Co", visibility: "public", isFeaturedDemo: true });

    const memberships = await listMemberships(user.id);
    const entry = memberships.find((m) => m.memexId === memex.id);
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("featured");
    expect(entry?.accessLevel).toBe("read");
    expect(entry?.role).toBe("member");
    expect(entry?.name).toBe("Explore Co");
    expect(entry?.visibility).toBe("public");
  });

  it("a PRIVATE memex with the flag set does NOT surface (public-only) (ac-10)", async () => {
    tagAc(AC_APPEARS);

    const user = await seedUser("noexplore-priv");
    const { memex } = await seedMemex({ name: "Private Featured Co", visibility: "private", isFeaturedDemo: true });

    const memberships = await listMemberships(user.id);
    expect(memberships.find((m) => m.memexId === memex.id)).toBeUndefined();
  });

  it("a public memex WITHOUT the flag does NOT surface as featured (ac-10)", async () => {
    tagAc(AC_APPEARS);

    const user = await seedUser("noexplore-unflagged");
    const { memex } = await seedMemex({ name: "Plain Public Co", visibility: "public", isFeaturedDemo: false });

    const memberships = await listMemberships(user.id);
    expect(memberships.find((m) => m.memexId === memex.id)).toBeUndefined();
  });

  it("an org member of the featured memex sees it ONCE via org (write), not duplicated as featured (ac-11, ac-8)", async () => {
    tagAc(AC_DEDUP);
    // Same behaviour is the spec-500 scope commitment ac-8 (members keep write,
    // no duplicate read-only entry) — verify it at the service level too.
    tagAc("mindset-prod/memex-building-itself/specs/spec-500/acs/ac-8");

    const member = await seedUser("featured-member");
    const { memex, org } = await seedMemex({ name: "Member Featured Co", visibility: "public", isFeaturedDemo: true });
    await db.insert(orgMemberships).values({ userId: member.id, orgId: org.id, role: "administrator" });

    const memberships = await listMemberships(member.id);
    const matches = memberships.filter((m) => m.memexId === memex.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("org");
    expect(matches[0].accessLevel).toBe("write");
  });

  it("featured takes precedence over a visited pin — still one 'featured' row after a visit (ac-10)", async () => {
    tagAc(AC_APPEARS);

    const user = await seedUser("featured-visitor");
    const { memex } = await seedMemex({ name: "Visited Featured Co", visibility: "public", isFeaturedDemo: true });

    // Simulate the user opening the Explore entry — a pin is written.
    await recordPublicMemexVisit(user.id, memex.id);

    const memberships = await listMemberships(user.id);
    const matches = memberships.filter((m) => m.memexId === memex.id);
    // Exactly one row, and it stays under "Explore" (source='featured'), NOT
    // "Visited" — the entry must not jump groups after the first click.
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("featured");
  });

  it("setFeaturedDemo flips the flag on an EXISTING memex row — no new memex created (ac-14)", async () => {
    tagAc(AC_EXISTING_ROW);

    const user = await seedUser("flip-explorer");
    // A pre-existing public memex, NOT featured. Before the flip it must not surface.
    const { memex } = await seedMemex({ name: "Pre-existing Co", visibility: "public", isFeaturedDemo: false });
    const before = await listMemberships(user.id);
    expect(before.find((m) => m.memexId === memex.id)).toBeUndefined();

    // Operator step: flip the flag on THAT SAME memex id (services/memexes.ts).
    await setFeaturedDemo(memex.id, true);

    const [row] = await db
      .select({ isFeaturedDemo: memexes.isFeaturedDemo })
      .from(memexes)
      .where(eq(memexes.id, memex.id));
    expect(row.isFeaturedDemo).toBe(true);

    // The same row now surfaces as the featured entry — no new memex was created.
    const after = await listMemberships(user.id);
    const entry = after.find((m) => m.memexId === memex.id);
    expect(entry?.source).toBe("featured");
  });

  it("listing a featured memex creates NO org_memberships row; the row stays read-only (ac-12)", async () => {
    tagAc(AC_READONLY);

    const user = await seedUser("readonly-explorer");
    const { memex, org } = await seedMemex({ name: "ReadOnly Co", visibility: "public", isFeaturedDemo: true });

    const memberships = await listMemberships(user.id);
    const entry = memberships.find((m) => m.memexId === memex.id);
    expect(entry?.accessLevel).toBe("read");

    // The load-bearing invariant: surfacing the featured entry must NOT grant
    // write by inserting a membership row (std-4). No org_memberships row exists.
    const membershipRows = await db
      .select({ userId: orgMemberships.userId })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.userId, user.id), eq(orgMemberships.orgId, org.id)));
    expect(membershipRows).toHaveLength(0);
  });
});
