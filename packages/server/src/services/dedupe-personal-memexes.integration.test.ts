import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, documents, decisions, users } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { createDecision } from "./decisions.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-293 t-4 (dec-4): the prod personal-Memex dedupe data migration. Seeds a
// user with THREE personal Memexes (the pre-fix race outcome), with colliding
// handles + content in the duplicates, then runs the real migration SQL and
// asserts: content merged into the canonical with no loss, empties removed, the
// ≤1-personal-Memex invariant holds, and a second run is a no-op.

const SPEC = "mindset-prod/memex-building-itself/specs/spec-293";
const ac = (n: number) => `${SPEC}/acs/ac-${n}`;

const MIGRATION_SQL = readFileSync(
  new URL("../../drizzle/0095_dedupe_personal_memexes.sql", import.meta.url),
  "utf8",
);

async function runMigration(): Promise<void> {
  await db.execute(sql.raw(MIGRATION_SQL));
}

// How many users currently have >1 personal Memex.
async function offenderCount(): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT n.owner_user_id
        FROM namespaces n
        JOIN memexes m ON m.namespace_id = n.id AND m.slug = 'personal'
       WHERE n.kind = 'user' AND n.owner_user_id IS NOT NULL
       GROUP BY n.owner_user_id
      HAVING count(*) > 1
    ) o
  `)) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

let userId: string;
let nsA: string;
let nsB: string;
let nsC: string;
let mxA: string;
let mxB: string;
let mxC: string;
let docA: string;
let docB: string;
let docC: string;

beforeAll(async () => {
  const user = await upsertUserByEmail(`dedupe-${Date.now()}@memex.ai`);
  userId = user.id;

  // Three user-namespaces owned by the same user, each with a 'personal' Memex.
  const stamp = Date.now();
  const [a, b, c] = await db
    .insert(namespaces)
    .values([
      { slug: `dedupe-a-${stamp}`, kind: "user", ownerUserId: userId },
      { slug: `dedupe-b-${stamp}`, kind: "user", ownerUserId: userId },
      { slug: `dedupe-c-${stamp}`, kind: "user", ownerUserId: userId },
    ])
    .returning({ id: namespaces.id });
  nsA = a!.id;
  nsB = b!.id;
  nsC = c!.id;

  const [ma, mb, mc] = await db
    .insert(memexes)
    .values([
      { namespaceId: nsA, slug: "personal", name: "Personal Memex" },
      { namespaceId: nsB, slug: "personal", name: "Personal Memex" },
      { namespaceId: nsC, slug: "personal", name: "Personal Memex" },
    ])
    .returning({ id: memexes.id });
  mxA = ma!.id;
  mxB = mb!.id;
  mxC = mc!.id;

  // users.namespaceId → nsA makes mxA the canonical.
  await db.update(users).set({ namespaceId: nsA }).where(eq(users.id, userId));

  // Content. All three use handle 'spec-1' to force handle re-mint on merge.
  const [da] = await db
    .insert(documents)
    .values({ memexId: mxA, handle: "spec-1", title: "Canonical doc", docType: "spec", status: "draft" })
    .returning({ id: documents.id });
  const [dbb] = await db
    .insert(documents)
    .values({ memexId: mxB, handle: "spec-1", title: "Dup B doc", docType: "spec", status: "draft" })
    .returning({ id: documents.id });
  const [dc] = await db
    .insert(documents)
    .values({ memexId: mxC, handle: "spec-1", title: "Dup C doc", docType: "spec", status: "draft" })
    .returning({ id: documents.id });
  docA = da!.id;
  docB = dbb!.id;
  docC = dc!.id;

  // A decision under the dup-B doc — must travel to the canonical with its doc.
  await createDecision(mxB, docB, "Decision that must survive");
});

afterAll(async () => {
  await db.delete(documents).where(inArray(documents.id, [docA, docB, docC])).catch(() => {});
  await db.delete(memexes).where(inArray(memexes.id, [mxA, mxB, mxC])).catch(() => {});
  await db.delete(namespaces).where(inArray(namespaces.id, [nsA, nsB, nsC])).catch(() => {});
});

describe("dedupe personal Memexes (dec-4)", () => {
  it("ac-14/ac-15: merges duplicates into the canonical, deletes empties, loses nothing, is idempotent", async () => {
    tagAc(ac(14));
    tagAc(ac(15));
    tagAc(ac(4)); // scope: idempotent, no-content-loss dedupe migration

    // Precondition: this user has 3 personal Memexes.
    const before = (await db.execute(sql`
      SELECT count(*)::int AS n FROM memexes m
        JOIN namespaces n ON n.id = m.namespace_id
       WHERE m.slug = 'personal' AND n.kind = 'user' AND n.owner_user_id = ${userId}
    `)) as unknown as Array<{ n: number }>;
    expect(before[0]!.n).toBe(3);
    expect(await offenderCount()).toBeGreaterThanOrEqual(1);

    const docCountBefore = (await db.execute(sql`
      SELECT count(*)::int AS n FROM documents WHERE id IN (${docA}, ${docB}, ${docC})
    `)) as unknown as Array<{ n: number }>;
    expect(docCountBefore[0]!.n).toBe(3);

    await runMigration();

    // The two duplicate Memexes are gone; the canonical remains.
    const remaining = await db
      .select({ id: memexes.id })
      .from(memexes)
      .where(inArray(memexes.id, [mxA, mxB, mxC]));
    expect(remaining.map((r) => r.id)).toEqual([mxA]);

    // No content lost: all three docs still exist…
    const docsAfter = await db
      .select({ id: documents.id, memexId: documents.memexId, handle: documents.handle })
      .from(documents)
      .where(inArray(documents.id, [docA, docB, docC]));
    expect(docsAfter).toHaveLength(3);
    // …and all now live in the canonical Memex…
    expect(docsAfter.every((d) => d.memexId === mxA)).toBe(true);
    // …with distinct (re-minted) handles — no unique-constraint violation.
    const handles = docsAfter.map((d) => d.handle);
    expect(new Set(handles).size).toBe(3);

    // The dup-B decision travelled to the canonical.
    const decRows = await db.select().from(decisions).where(eq(decisions.docId, docB));
    expect(decRows.length).toBeGreaterThanOrEqual(1);
    expect(decRows.every((d) => d.memexId === mxA)).toBe(true);

    // Invariant (ac-14): no user has >1 personal Memex.
    expect(await offenderCount()).toBe(0);

    // Idempotent (ac-15): re-running raises nothing and changes nothing.
    await expect(runMigration()).resolves.not.toThrow();
    const stillOne = await db
      .select({ id: memexes.id })
      .from(memexes)
      .where(and(inArray(memexes.id, [mxA, mxB, mxC])));
    expect(stillOne.map((r) => r.id)).toEqual([mxA]);
  });
});
