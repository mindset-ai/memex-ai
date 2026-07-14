// spec-481 t-1 — renameNamespaceSlug writes a namespace_rename redirect so old
// namespace URLs forward (ac-3), and isSlugAvailable rejects a slug that is the
// source of a live redirect (D-2 reuse-guard, ac-5).
//
// Per-worker-unique slugs (std-37); redirect + reservation rows created here are
// swept afterEach (std-39 hygiene).

import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { namespaces, memexes, users } from "../db/schema.js";
import { renameNamespaceSlug } from "./namespaces.js";
import { isSlugAvailable } from "./shared/slug.js";
import { insertRedirect, lookupRedirect } from "./redirects.js";

const AC_481_REDIRECT =
  "mindset-prod/memex-building-itself/specs/spec-481/acs/ac-3";
const AC_481_GUARD =
  "mindset-prod/memex-building-itself/specs/spec-481/acs/ac-5";

function stem(): string {
  return `s481${Math.random().toString(36).slice(2, 8)}`;
}

const slugsToClean: string[] = [];
afterEach(async () => {
  while (slugsToClean.length) {
    const s = slugsToClean.pop()!;
    await db
      .execute(
        sql`DELETE FROM redirects WHERE old_path LIKE ${s + "%"} OR new_path LIKE ${s + "%"}`,
      )
      .catch(() => {});
    await db
      .execute(sql`DELETE FROM namespace_slug_reservations WHERE slug LIKE ${s + "%"}`)
      .catch(() => {});
  }
});

// Seed a personal (user-kind) namespace + one memex; returns the ids + slug.
async function seedUserNamespace(oldSlug: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `${oldSlug}@example.com` } as typeof users.$inferInsert)
    .returning();
  const [ns] = await db
    .insert(namespaces)
    .values({ slug: oldSlug, kind: "user", ownerUserId: user.id })
    .returning();
  await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: "Main" })
    .returning();
  return { userId: user.id, namespaceId: ns.id };
}

describe("renameNamespaceSlug redirect + reuse-guard (spec-481 t-1)", () => {
  it("writes a namespace_rename redirect so a stale namespace path forwards", async () => {
    tagAc(AC_481_REDIRECT);
    const base = stem();
    const oldSlug = `${base}o`;
    const newSlug = `${base}n`;
    slugsToClean.push(base);
    const { userId, namespaceId } = await seedUserNamespace(oldSlug);

    await renameNamespaceSlug({ namespaceId, newSlug, userId });

    const ns = await db.query.namespaces.findFirst({
      where: (n, { eq }) => eq(n.id, namespaceId),
      columns: { slug: true },
    });
    expect(ns?.slug).toBe(newSlug);

    // A deep path under the old namespace forwards to the new one.
    const result = await lookupRedirect(`${oldSlug}/main/specs/spec-1/tasks/t-1`);
    expect(result).toEqual({
      redirected: `${newSlug}/main/specs/spec-1/tasks/t-1`,
    });
  });

  it("isSlugAvailable rejects a slug that is the source of a live redirect", async () => {
    tagAc(AC_481_GUARD);
    const base = stem();
    const orphan = `${base}src`; // never reserved — only a redirect source
    slugsToClean.push(base);

    // Available before any redirect exists.
    expect(await isSlugAvailable(orphan)).toBe(true);

    await insertRedirect(orphan, `${base}dst`, "namespace_rename");

    // Now unavailable purely because it is a redirect source (no reservation).
    expect(await isSlugAvailable(orphan)).toBe(false);
  });
});
