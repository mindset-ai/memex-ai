import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-181 t (data-migration slice) — the plan→specify rename migration.
//
// The second Spec pipeline phase renames from `plan` to `specify`
// (draft → specify → build → verify → done). dec-2 mandates a SINGLE atomic
// Drizzle migration shipping with the code (same shape as spec-105's 0034/0065
// pattern); dec-3 mandates ZERO statements against document_sections (no prose
// rewrite — the word "plan" survives in section bodies untouched).
//
// The local test database is already migrated to the POST-state (constraints
// already say 'specify'). So each test reconstructs the PRE-migration state
// inside a rolled-back transaction — drop the new CHECKs, re-add the original
// 'plan' CHECKs, seed 'plan' rows + section prose — then runs the real UP SQL
// file against that transaction and asserts the contract. ac-13 additionally
// runs the real DOWN (revert) SQL and asserts the pre-state is restored.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-181/acs/ac-${n}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/server/src/db/<this file> → packages/server/drizzle is ../../drizzle
const DRIZZLE_DIR = resolve(__dirname, "../../drizzle");
const UP_SQL_PATH = resolve(DRIZZLE_DIR, "0078_plan_to_specify.sql");
const DOWN_SQL_PATH = resolve(
  DRIZZLE_DIR,
  "reverts/0078_plan_to_specify.revert.sql",
);

// The drizzle transaction handle (what `db.transaction(async (tx) => …)` yields).
// Nested `tx.transaction` yields the same type and maps to a SAVEPOINT.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let UP_SQL = "";
let DOWN_SQL = "";

// The migration files wrap their statements in `BEGIN; … COMMIT;` (the hand-
// migration runner applies each file with psql --single-transaction). When we
// execute the file's body INSIDE a test transaction we must strip the outer
// BEGIN/COMMIT — a nested COMMIT would otherwise commit the test's transaction
// and defeat the rollback isolation that keeps the shared worker DB pristine.
function stripOuterTransaction(sqlText: string): string {
  return sqlText
    .replace(/^\s*BEGIN\s*;/im, "")
    .replace(/COMMIT\s*;\s*$/im, "");
}

beforeAll(() => {
  UP_SQL = stripOuterTransaction(readFileSync(UP_SQL_PATH, "utf8"));
  DOWN_SQL = stripOuterTransaction(readFileSync(DOWN_SQL_PATH, "utf8"));
});

// Section bodies that contain the word "plan" in three distinct senses. Per
// dec-3 these must survive the migration byte-for-byte — the migration touches
// NO content/body column.
const SECTION_PROSE = {
  phase:
    "When the Spec reaches the plan phase the agent drafts decisions before any task.",
  execution:
    "Execution plan: ship the migration atomically, then flip the kanban column.",
  english:
    "We plan to take a long weekend; the best-laid plans of mice and men.",
};

type Row = Record<string, unknown>;

/**
 * Reconstructs the PRE-migration DB shape inside `tx`, seeds the fixtures, then
 * hands the transaction to `body`. Always rolls back so the suite leaves no
 * residue and the shared worker DB schema is unperturbed.
 */
async function withPreMigrationFixture(
  body: (tx: Tx, ids: {
    memexId: string;
    orgId: string;
    userId: string;
    docId: string;
    sectionIds: { phase: string; execution: string; english: string };
  }) => Promise<void>,
): Promise<void> {
  await db
    .transaction(async (tx) => {
      // 1. The shared worker DB is migrated to the POST-0078 state (CHECKs admit
      //    'specify', not 'plan'). Run the REAL revert SQL to bring the whole
      //    table back to the pre-migration shape — it flips any 'specify' rows to
      //    'plan' and restores the original 'plan'-admitting CHECKs, so we can
      //    then seed legacy 'plan' rows the post-migration schema would reject.
      //    (Reusing DOWN_SQL here also means the pre-state we test UP against is
      //    exactly the state the shipped revert produces.)
      await tx.execute(sql.raw(DOWN_SQL));

      // 2. Tenancy scaffolding.
      const ns = (await tx.execute(
        sql`insert into namespaces (slug, kind)
            values ('spec181-mig-ns', 'org') returning id`,
      )) as unknown as Row[];
      const nsId = ns[0]!.id as string;

      const org = (await tx.execute(
        sql`insert into orgs (namespace_id, name)
            values (${nsId}, 'spec181 org') returning id`,
      )) as unknown as Row[];
      const orgId = org[0]!.id as string;

      const user = (await tx.execute(
        sql`insert into users (email) values ('spec181-mig@example.com') returning id`,
      )) as unknown as Row[];
      const userId = user[0]!.id as string;

      const mx = (await tx.execute(
        sql`insert into memexes (namespace_id, slug, name)
            values (${nsId}, 'spec181-mig-mx', 'mig') returning id`,
      )) as unknown as Row[];
      const memexId = mx[0]!.id as string;

      // 3. A Spec document with the LEGACY status='plan'.
      const doc = (await tx.execute(
        sql`insert into documents (memex_id, handle, title, doc_type, status)
            values (${memexId}, 'spec-1', 'Plan-phase Spec', 'spec', 'plan')
            returning id`,
      )) as unknown as Row[];
      const docId = doc[0]!.id as string;

      // 4. document_sections rows: three senses of the word "plan". These must
      //    NOT be touched by the migration (dec-3).
      let nextSeq = 0;
      const mkSection = async (sectionType: string, content: string) => {
        const seq = nextSeq++;
        const r = (await tx.execute(
          sql`insert into doc_sections (doc_id, section_type, content, seq, position)
              values (${docId}, ${sectionType}, ${content}, ${seq}, ${seq})
              returning id`,
        )) as unknown as Row[];
        return r[0]!.id as string;
      };
      const sectionIds = {
        phase: await mkSection("phase", SECTION_PROSE.phase),
        execution: await mkSection("execution", SECTION_PROSE.execution),
        english: await mkSection("english", SECTION_PROSE.english),
      };

      // 5. org_scaffold_additions rows targeting the LEGACY 'plan' phase /
      //    transition.
      await tx.execute(
        sql`insert into org_scaffold_additions
              (org_id, target_phase, text, rationale, author_id)
            values (${orgId}, 'plan', 'phase-targeted block', 'why', ${userId})`,
      );
      await tx.execute(
        sql`insert into org_scaffold_additions
              (org_id, target_transition, text, rationale, author_id)
            values (${orgId}, 'plan', 'transition-targeted block', 'why', ${userId})`,
      );

      await body(tx, { memexId, orgId, userId, docId, sectionIds });

      tx.rollback();
    })
    .catch((e) => {
      // db.transaction throws on tx.rollback() by design — swallow only that.
      if (!(e instanceof Error && e.message.includes("Rollback"))) throw e;
    });
}

async function countPlanStatuses(tx: Tx, memexId: string): Promise<number> {
  const r = (await tx.execute(
    sql`select count(*)::int as n from documents
        where memex_id = ${memexId} and status = 'plan'`,
  )) as unknown as Row[];
  return r[0]!.n as number;
}

async function countPlanScaffold(tx: Tx, orgId: string): Promise<number> {
  const r = (await tx.execute(
    sql`select count(*)::int as n from org_scaffold_additions
        where org_id = ${orgId}
          and (target_phase = 'plan' or target_transition = 'plan')`,
  )) as unknown as Row[];
  return r[0]!.n as number;
}

// A failed statement aborts the enclosing Postgres transaction — every
// subsequent statement then errors with "current transaction is aborted". To
// probe a CHECK constraint without poisoning the outer test transaction, run the
// probing statement inside a SAVEPOINT (drizzle's nested `tx.transaction`):
// rolling the savepoint back on failure leaves the outer transaction usable.

/** Assert a statement is REJECTED (CHECK/constraint violation), savepoint-isolated. */
async function expectRejected(
  tx: Tx,
  build: (sp: Tx) => Promise<unknown>,
  msg: string,
): Promise<void> {
  let rejected = false;
  try {
    await tx.transaction(async (sp) => {
      await build(sp);
    });
  } catch {
    rejected = true;
  }
  expect(rejected, msg).toBe(true);
}

/** Assert a statement is ACCEPTED, then roll it back so it leaves no residue. */
async function expectAccepted(
  tx: Tx,
  build: (sp: Tx) => Promise<unknown>,
  msg: string,
): Promise<void> {
  let accepted = true;
  try {
    await tx.transaction(async (sp) => {
      await build(sp);
      sp.rollback(); // undo the successful insert; we only care that it was legal
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("Rollback")) {
      // expected: our own sp.rollback() — the insert was accepted.
    } else {
      accepted = false;
    }
  }
  expect(accepted, msg).toBe(true);
}

describe("spec-181 plan→specify migration", () => {
  it("UP migration: flips every 'plan' to 'specify' and the CHECK rejects 'plan', accepts 'specify' (ac-12)", async () => {
    tagAc(AC(12));

    await withPreMigrationFixture(async (tx, { memexId, orgId, userId, docId }) => {
      // Sanity: the pre-state has 'plan' rows.
      expect(await countPlanStatuses(tx, memexId)).toBe(1);
      expect(await countPlanScaffold(tx, orgId)).toBe(2);

      // Run the real UP migration SQL against this transaction.
      await tx.execute(sql.raw(UP_SQL));

      // Zero 'plan' values remain anywhere the migration touches.
      expect(
        await countPlanStatuses(tx, memexId),
        "no documents.status='plan' may remain after UP",
      ).toBe(0);
      expect(
        await countPlanScaffold(tx, orgId),
        "no org_scaffold_additions target_phase/target_transition='plan' may remain after UP",
      ).toBe(0);

      // The seeded Spec is now 'specify'.
      const after = (await tx.execute(
        sql`select status from documents where id = ${docId}`,
      )) as unknown as Row[];
      expect(after[0]!.status).toBe("specify");

      // The CHECK now REJECTS a fresh 'plan' insert...
      await expectRejected(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into documents (memex_id, handle, title, doc_type, status)
                values (${memexId}, 'spec-reject', 'X', 'spec', 'plan')`,
          ),
        "documents_status_valid must reject status='plan' after UP",
      );

      // ...and ACCEPTS 'specify'.
      await expectAccepted(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into documents (memex_id, handle, title, doc_type, status)
                values (${memexId}, 'spec-accept', 'X', 'spec', 'specify')`,
          ),
        "documents_status_valid must accept status='specify' after UP",
      );

      // The legacy non-Spec values must still be permitted (execution-plan rows
      // carry draft/review/implementation/done/approved).
      for (const legacy of [
        "draft",
        "review",
        "implementation",
        "done",
        "approved",
        "build",
        "verify",
      ]) {
        await expectAccepted(
          tx,
          (sp) =>
            sp.execute(
              sql`insert into documents (memex_id, handle, title, doc_type, status)
                  values (${memexId}, ${"legacy-" + legacy}, 'X', 'doc', ${legacy})`,
            ),
          `documents_status_valid must still accept legacy status='${legacy}'`,
        );
      }

      // Scaffold CHECKs accept 'specify', reject 'plan'.
      await expectAccepted(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into org_scaffold_additions
                  (org_id, target_phase, text, rationale, author_id)
                values (${orgId}, 'specify', 't', 'r', ${userId})`,
          ),
        "target_phase CHECK must accept 'specify' after UP",
      );
      await expectRejected(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into org_scaffold_additions
                  (org_id, target_phase, text, rationale, author_id)
                values (${orgId}, 'plan', 't', 'r', ${userId})`,
          ),
        "target_phase CHECK must reject 'plan' after UP",
      );
      await expectRejected(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into org_scaffold_additions
                  (org_id, target_transition, text, rationale, author_id)
                values (${orgId}, 'plan', 't', 'r', ${userId})`,
          ),
        "target_transition CHECK must reject 'plan' after UP",
      );
    });
  });

  it("section bodies are byte-identical after the migration — no prose rewrite (ac-14)", async () => {
    tagAc(AC(14));
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-5");

    await withPreMigrationFixture(async (tx, { sectionIds }) => {
      await tx.execute(sql.raw(UP_SQL));

      const ids = [sectionIds.phase, sectionIds.execution, sectionIds.english];
      const rows = (await tx.execute(
        sql`select id, content from doc_sections where id in
            (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
      )) as unknown as Row[];
      const byId = new Map(rows.map((r) => [r.id as string, r.content as string]));

      expect(byId.get(sectionIds.phase)).toBe(SECTION_PROSE.phase);
      expect(byId.get(sectionIds.execution)).toBe(SECTION_PROSE.execution);
      expect(byId.get(sectionIds.english)).toBe(SECTION_PROSE.english);

      // The word "plan" still appears in all three bodies — proof the migration
      // ran zero content rewrites.
      for (const v of byId.values()) {
        expect(v.toLowerCase()).toContain("plan");
      }
    });
  });

  it("DOWN migration restores the pre-migration state exactly (ac-13)", async () => {
    tagAc(AC(13));
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-8");

    await withPreMigrationFixture(async (tx, { memexId, orgId, userId, docId }) => {
      // UP then DOWN.
      await tx.execute(sql.raw(UP_SQL));
      await tx.execute(sql.raw(DOWN_SQL));

      // Rows are back to 'plan'.
      expect(
        await countPlanStatuses(tx, memexId),
        "DOWN must restore documents.status='plan'",
      ).toBe(1);
      expect(
        await countPlanScaffold(tx, orgId),
        "DOWN must restore scaffold target_phase/target_transition='plan'",
      ).toBe(2);

      const after = (await tx.execute(
        sql`select status from documents where id = ${docId}`,
      )) as unknown as Row[];
      expect(after[0]!.status).toBe("plan");

      // The original CHECK is restored: accepts 'plan'...
      await expectAccepted(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into documents (memex_id, handle, title, doc_type, status)
                values (${memexId}, 'spec-redown', 'X', 'spec', 'plan')`,
          ),
        "documents_status_valid must accept status='plan' again after DOWN",
      );

      // ...and rejects 'specify'.
      await expectRejected(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into documents (memex_id, handle, title, doc_type, status)
                values (${memexId}, 'spec-rejspec', 'X', 'spec', 'specify')`,
          ),
        "documents_status_valid must reject status='specify' after DOWN",
      );

      // Scaffold CHECKs accept 'plan' again, and reject 'specify'.
      await expectAccepted(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into org_scaffold_additions
                  (org_id, target_phase, text, rationale, author_id)
                values (${orgId}, 'plan', 't', 'r', ${userId})`,
          ),
        "target_phase CHECK must accept 'plan' again after DOWN",
      );
      await expectAccepted(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into org_scaffold_additions
                  (org_id, target_transition, text, rationale, author_id)
                values (${orgId}, 'plan', 't', 'r', ${userId})`,
          ),
        "target_transition CHECK must accept 'plan' again after DOWN",
      );
      await expectRejected(
        tx,
        (sp) =>
          sp.execute(
            sql`insert into org_scaffold_additions
                  (org_id, target_phase, text, rationale, author_id)
                values (${orgId}, 'specify', 't', 'r', ${userId})`,
          ),
        "target_phase CHECK must reject 'specify' after DOWN",
      );
    });
  });
});
