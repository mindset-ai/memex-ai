// spec-179 t-1 — clause_refs against a real DB.
//
// Three surfaces:
//   1. parseHandleRefs — the pure parser (kind mapping, dedupe, legacy b-N).
//   2. syncClauseRefsTx via the clause service — every clause mutation
//      re-derives rows in the same transaction (ac-9), memex-scoped
//      resolution (ac-12).
//   3. The 0076 backfill SQL executed verbatim (lock-step with the TS parser)
//      against seeded corpus rows (ac-10).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { clauseRefs, documents, docSections, standardClauses } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createClause, updateClause, deleteClause } from "./clauses.js";
import { makeTestMemex } from "./test-helpers.js";
import { parseHandleRefs } from "./clause-refs.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-179/acs/ac-${n}`;

let memexA: string;
let memexB: string;
const createdDocIds: string[] = [];

beforeAll(async () => {
  memexA = await makeTestMemex("clrefs-a");
  memexB = await makeTestMemex("clrefs-b");
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds));
  }
});

// A target doc with a fixed handle (e.g. 'std-2') the parser can resolve to.
async function seedTarget(memexId: string, handle: string, docType = "standard"): Promise<string> {
  const [row] = await db
    .insert(documents)
    .values({ memexId, handle, title: `target ${handle}`, docType })
    .returning();
  createdDocIds.push(row.id);
  return row.id;
}

async function freshSection(memexId: string): Promise<{ docId: string; sectionId: string }> {
  const doc = await createDocDraft(memexId, "Clause-refs test standard", "purpose");
  createdDocIds.push(doc.id);
  const section = await addSection(memexId, doc.id, "rule", "Rule prose.");
  return { docId: doc.id, sectionId: section.id };
}

async function refsForClause(clauseId: string) {
  return db.select().from(clauseRefs).where(eq(clauseRefs.sourceClauseId, clauseId));
}

describe("parseHandleRefs (pure parser)", () => {
  it("maps prefixes to kinds, dedupes, and treats legacy b-N as spec", () => {
    tagAc(AC(9));
    const refs = parseHandleRefs(
      "Pairs with std-2 and std-2 again; see spec-9 dec-8, legacy b-65, doc-15, and cl-100.",
    );
    expect(refs).toEqual([
      { kind: "standard", handle: "std-2", docLevel: true },
      { kind: "spec", handle: "spec-9", docLevel: true },
      { kind: "decision", handle: "dec-8", docLevel: false },
      { kind: "spec", handle: "b-65", docLevel: true },
      { kind: "document", handle: "doc-15", docLevel: true },
      { kind: "clause", handle: "cl-100", docLevel: false },
    ]);
  });

  it("ignores non-handle tokens", () => {
    tagAc(AC(9));
    expect(parseHandleRefs("cli-3, standard-4, b2b, specN, nothing here")).toEqual([]);
  });
});

describe("syncClauseRefsTx via the clause service (ac-9)", () => {
  it("createClause materializes refs in the same mutation; resolution is memex-scoped", async () => {
    tagAc(AC(9));
    tagAc(AC(12));
    const std2 = await seedTarget(memexA, "std-2");
    const { sectionId } = await freshSection(memexA);

    const clause = await createClause(
      memexA,
      sectionId,
      "- Pairs with std-2; constrained by std-99 (nonexistent); see dec-4.\n",
    );

    const rows = await refsForClause(clause.id);
    const byHandle = Object.fromEntries(rows.map((r) => [r.targetHandle, r]));
    expect(rows).toHaveLength(3);
    expect(byHandle["std-2"]).toMatchObject({ targetKind: "standard", targetDocId: std2 });
    // Unresolvable handle → row kept, no target (no edge — ac-12).
    expect(byHandle["std-99"]).toMatchObject({ targetKind: "standard", targetDocId: null });
    // Doc-relative kind → never resolved.
    expect(byHandle["dec-4"]).toMatchObject({ targetKind: "decision", targetDocId: null });
  });

  it("never resolves across memexes — B's std-7 is invisible to A's clauses", async () => {
    tagAc(AC(12));
    await seedTarget(memexB, "std-7"); // exists ONLY in memex B
    const { sectionId } = await freshSection(memexA);

    const clause = await createClause(memexA, sectionId, "- Cites std-7.\n");

    const rows = await refsForClause(clause.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetHandle: "std-7", targetDocId: null });
  });

  it("updateClause replaces the row set", async () => {
    tagAc(AC(9));
    const std3 = await seedTarget(memexA, "std-3");
    const std4 = await seedTarget(memexA, "std-4");
    const { sectionId } = await freshSection(memexA);
    const clause = await createClause(memexA, sectionId, "- Cites std-3.\n");

    await updateClause(memexA, clause.id, "- Now cites std-4 instead.\n");

    const rows = await refsForClause(clause.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetHandle: "std-4", targetDocId: std4 });
    expect(rows.some((r) => r.targetDocId === std3)).toBe(false);
  });

  it("deleteClause removes its refs", async () => {
    tagAc(AC(9));
    await seedTarget(memexA, "std-5");
    const { sectionId } = await freshSection(memexA);
    const clause = await createClause(memexA, sectionId, "- Cites std-5.\n");
    expect(await refsForClause(clause.id)).toHaveLength(1);

    await deleteClause(memexA, clause.id);

    expect(await refsForClause(clause.id)).toHaveLength(0);
  });
});

describe("0076 backfill SQL — lock-step with the TS parser (ac-10)", () => {
  it("populates clause_refs from seeded clause bodies and standard-section preambles", async () => {
    tagAc(AC(10));
    const memex = await makeTestMemex("clrefs-bf");
    const target = await seedTarget(memex, "std-2");

    // A standard with one clause + one legacy decomposed section (preamble),
    // seeded DIRECTLY (no service) — exactly what the migration encounters.
    const [doc] = await db
      .insert(documents)
      .values({ memexId: memex, handle: "std-9", title: "backfill std", docType: "standard" })
      .returning();
    createdDocIds.push(doc.id);
    const [section] = await db
      .insert(docSections)
      .values({
        docId: doc.id,
        sectionType: "rule",
        content: "It pairs with std-2.",
        preamble: "Preamble citing std-2 and dec-8.",
        seq: 1,
        position: 1,
      })
      .returning();
    const [clause] = await db
      .insert(standardClauses)
      .values({
        memexId: memex,
        docId: doc.id,
        sectionId: section.id,
        seq: 1,
        position: 1,
        body: "It pairs with std-2 (and the deleted one cites nothing).",
      })
      .returning();
    // A soft-deleted clause must NOT be backfilled.
    await db.insert(standardClauses).values({
      memexId: memex,
      docId: doc.id,
      sectionId: section.id,
      seq: 2,
      position: 2,
      body: "Deleted clause citing std-2.",
      status: "deleted",
    });

    // Execute the migration's backfill section verbatim (lock-step contract).
    // Comment lines are stripped, then each `;`-terminated INSERT runs as-is.
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(join(here, "../../drizzle/0076_add_clause_refs.sql"), "utf8");
    const raw = migration.split("-- BACKFILL --")[1];
    expect(raw).toBeTruthy();
    const statements = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(2);
    const runBackfill = async () => {
      for (const statement of statements) {
        await db.execute(sql.raw(statement));
      }
    };
    await runBackfill();

    const rows = await db.select().from(clauseRefs).where(eq(clauseRefs.memexId, memex));
    // Clause body → 1 ref (std-2, resolved). Preamble → 2 refs (std-2 resolved, dec-8 null).
    const clauseRows = rows.filter((r) => r.sourceClauseId === clause.id);
    expect(clauseRows).toHaveLength(1);
    expect(clauseRows[0]).toMatchObject({ targetHandle: "std-2", targetDocId: target });

    const preambleRows = rows.filter((r) => r.sourceSectionId === section.id);
    expect(preambleRows.map((r) => r.targetHandle).sort()).toEqual(["dec-8", "std-2"]);
    expect(preambleRows.find((r) => r.targetHandle === "std-2")!.targetDocId).toBe(target);

    // The deleted clause contributed nothing.
    expect(rows.filter((r) => r.sourceClauseId && r.sourceClauseId !== clause.id)).toHaveLength(0);

    // Idempotent: re-running the backfill adds no rows (ON CONFLICT DO NOTHING).
    await runBackfill();
    const again = await db.select().from(clauseRefs).where(eq(clauseRefs.memexId, memex));
    expect(again).toHaveLength(rows.length);
  });
});
