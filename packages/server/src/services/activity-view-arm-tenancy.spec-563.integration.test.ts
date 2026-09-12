// spec-563 t-4 (ac-3) — the pattern is fixed, not just the one arm.
//
// ac-3 asks that "every UNION arm is walked and states where its memex_id comes from". A
// one-time walk recorded in prose rots the moment someone adds a ninth arm. This is the
// walk expressed as a guard.
//
// THE INVARIANT, and why it is spelled this way. pg_get_viewdef renders a column that is
// already named correctly as a BARE reference — `te.memex_id`, no alias. It only emits
// `AS memex_id` when the value is an EXPRESSION that needs renaming: a correlated
// subquery, a COALESCE, a join-recovered column. So:
//
//     the live definition contains `AS memex_id`  ⇔  some arm derives its tenant
//
// One assertion covers all eight arms and any arm added later, without naming them.
//
// ⚠ WHY THIS IS READ FROM THE CATALOGUE AND NOT FROM A MIGRATION FILE. activity_view is
// defined across six migrations, and 0142 recreates it dynamically from pg_get_viewdef
// without carrying its text — so no file in the repo is the view's definition [spec-564].
// Asserting against a file would test a fiction. This Spec's entire first draft was that
// mistake.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users, namespaces, orgs, orgMemberships, memexes, documents } from "../db/schema.js";
import { createDocDraft } from "./documents.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-563/acs";

// The FK probe needs a document of its own to aim at. std-37: per-worker-unique.
let seededMemexId: string;
let seededUserId: string;

beforeAll(async () => {
  const sub = `s563fk-${process.env.VITEST_WORKER_ID ?? "0"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `${sub}@memex.ai`, name: "FK probe" } as typeof users.$inferInsert)
    .returning();
  seededUserId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` })
    .returning();
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  seededMemexId = mx.id;
});

afterAll(async () => {
  if (seededMemexId)
    await db.delete(documents).where(eq(documents.memexId, seededMemexId)).catch(() => {});
  if (seededMemexId) await db.delete(memexes).where(eq(memexes.id, seededMemexId)).catch(() => {});
  if (seededUserId) await db.delete(users).where(eq(users.id, seededUserId)).catch(() => {});
});

async function liveViewDef(): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT pg_get_viewdef('activity_view'::regclass, true) AS def`,
  )) as unknown as { def: string }[];
  return rows[0].def;
}

describe("activity_view: no arm recovers its tenant [spec-563 t-4]", () => {
  it("ac-3: every UNION arm takes memex_id from a column, never from an expression", async () => {
    tagAc(`${AC}/ac-3`);

    const def = await liveViewDef();

    // Vacuity guard — if the view were missing or empty, every assertion below would pass
    // for the wrong reason (std-45 cl-4).
    expect(def.length).toBeGreaterThan(500);
    expect(def).toContain("UNION ALL");
    expect((def.match(/UNION ALL/g) ?? []).length).toBe(7); // 8 arms

    // The invariant. Before 0147 this failed on the doc_sections arm, whose tenant came
    // from `( SELECT pd.memex_id FROM documents pd WHERE pd.id = s.doc_id) AS memex_id`.
    expect(def).not.toMatch(/AS memex_id/);

    // And the specific shape that was there, named so a reader of a future failure knows
    // what it looked like rather than only that a regex tripped.
    expect(def).not.toContain("FROM documents pd");
  });

  it("ac-3: the guard above can fail — a derived tenant is detectable", async () => {
    tagAc(`${AC}/ac-3`);

    // Proving the invariant is not vacuous: build a view that DOES derive its tenant and
    // confirm the same assertion catches it. Without this, `not.toMatch` would pass just as
    // happily against a rendering convention that never emits `AS memex_id` at all — and
    // the guard would be decoration.
    const probe = `spec563_derived_tenant_probe_${process.env.VITEST_WORKER_ID ?? "0"}`;
    await db.execute(
      sql.raw(`
        CREATE OR REPLACE VIEW ${probe} AS
        SELECT s.id,
               (SELECT pd.memex_id FROM documents pd WHERE pd.id = s.doc_id) AS memex_id
          FROM doc_sections s`),
    );
    try {
      const rows = (await db.execute(
        sql.raw(`SELECT pg_get_viewdef('${probe}'::regclass, true) AS def`),
      )) as unknown as { def: string }[];
      expect(rows[0].def).toMatch(/AS memex_id/);
    } finally {
      await db.execute(sql.raw(`DROP VIEW IF EXISTS ${probe}`));
    }
  });

  it("ac-3: a section whose tenant disagrees with its document's cannot be written", async () => {
    tagAc(`${AC}/ac-3`);

    // ⚠ THIS TEST USED TO COUNT MISMATCHES ACROSS THE WHOLE DATABASE, and that was wrong
    // twice over. It went red in CI (`expected 1 to be +0`) while passing locally — not
    // because CI is different, but because the assertion depended on what OTHER tests in
    // the same shard had left behind [std-37: fixtures must be isolated]. A check that
    // needs global state to find a defect will also miss it when the ordering changes.
    //
    // The invariant it was reaching for is real, so it moved to where invariants belong:
    // a composite FK, doc_sections (doc_id, memex_id) → documents (id, memex_id), added by
    // 0148. A wrong tenant now fails AT THE INSERT, naming the row, instead of surfacing
    // minutes later as an aggregate in an unrelated shard.
    //
    // What is left here is the isolated proof that the constraint is live and does bite.
    const rows = (await db.execute(sql`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'doc_sections'::regclass
         AND conname = 'doc_sections_doc_id_memex_id_fkey'
    `)) as unknown as { conname: string }[];
    expect(rows.length).toBe(1);

    // And that it is not decorative: writing a section under a tenant that is not its
    // document's must be refused by the DATABASE, not merely discouraged by convention.
    //
    // ⚠ The first version of this read `FROM documents d LIMIT 1` with no fixture of its
    // own. When the clone held no documents the INSERT…SELECT matched no rows, inserted
    // nothing, threw nothing, and the assertion failed — which is the lucky version of
    // that mistake. Had it been written as `.resolves` it would have passed forever
    // against a constraint that does not exist. The test now seeds its own target and
    // asserts it exists first [std-45 cl-4].
    const doc = await createDocDraft(seededMemexId, "FK probe", "FK", "spec");
    const docRows = (await db.execute(
      sql`SELECT memex_id FROM documents WHERE id = ${doc.id}`,
    )) as unknown as { memex_id: string }[];
    expect(docRows.length).toBe(1);
    expect(docRows[0].memex_id).toBe(seededMemexId);

    // ⚠ Assert on the CAUSE, not the surface message. Drizzle wraps a driver error in a
    // generic `Failed query: …`, so `.rejects.toThrow(/foreign key/)` fails even when the
    // constraint fired correctly — the first version of this assertion did exactly that
    // and would have been easy to misread as "the FK is not working".
    let caught: unknown;
    try {
      await db.execute(sql`
        INSERT INTO doc_sections (doc_id, memex_id, section_type, content, seq, position)
        VALUES (${doc.id},
                '00000000-0000-0000-0000-000000000001'::uuid,  -- deliberately not the doc's
                'rule', 'x', 9999, 9999)
      `);
    } catch (err) {
      caught = err;
    }

    expect(caught, "the write was ACCEPTED — the tenancy FK is not enforcing").toBeDefined();
    const cause = (caught as { cause?: { code?: string; constraint_name?: string } }).cause;
    // 23503 = foreign_key_violation. Asserting the SQLSTATE rather than prose keeps this
    // independent of Postgres's message wording across versions and locales.
    expect(cause?.code).toBe("23503");
    expect(cause?.constraint_name).toBe("doc_sections_doc_id_memex_id_fkey");
  });
});
