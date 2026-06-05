// spec-150 t-6 — the decomposition migration's safety protocol, on isolated seeded
// standards (never the real corpus). The translator is injected (deterministic, no
// LLM) so we test the protocol, not the model: decomposition yields the partition
// invariant content === clauses.join (ac-3), the backup round-trips on restore
// (ac-6, ac-15), validation catches a broken partition (ac-16), and no per-clause
// embedding is introduced (ac-14). Each test uses a fresh memex so
// decomposeAllStandards({memexId}) only touches its own standard.

import { describe, it, expect, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, standardClauses } from "../db/schema.js";
import { createStandard } from "./standards.js";
import { makeTestMemex } from "./test-helpers.js";
import {
  decomposeAllStandards,
  backupStandards,
  validateClausePartition,
  restoreStandardsFromBackup,
  dropBackup,
  type TranslateFn,
} from "./standards-migration.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-150/acs/ac-${n}`;

// Deterministic stand-in for the LLM translator: one clause per line, list markers
// stripped. Reword-shaped (output bytes differ from input), like the real translator.
const fakeTranslate: TranslateFn = async (content) =>
  content
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.length > 0);

const createdDocIds: string[] = [];

afterAll(async () => {
  await dropBackup();
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

async function seedStandard(): Promise<{
  memexId: string;
  docId: string;
  sectionId: string;
  content: string;
}> {
  const memexId = await makeTestMemex();
  const content = "These invariants hold.\n\n- Rule one is mandatory.\n- Rule two is also mandatory.\n";
  const std = await createStandard(memexId, {
    title: "Migration Test Standard",
    sections: [{ sectionType: "rule", content }],
  });
  createdDocIds.push(std.id);
  const section = await db.query.docSections.findFirst({
    where: eq(docSections.docId, std.id),
  });
  return { memexId, docId: std.id, sectionId: section!.id, content };
}

describe("spec-150 t-6: standards decomposition migration", () => {
  it("decomposes sections so content === clauses.join, preamble nulled (ac-3)", async () => {
    tagAc(AC(3));
    const { memexId, docId, sectionId } = await seedStandard();

    const report = await decomposeAllStandards({ memexId, translate: fakeTranslate });
    expect(report.sectionsDecomposed).toBe(1);
    expect(report.clausesCreated).toBe(3); // preamble line + two rules

    const after = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
    const clauses = await db
      .select()
      .from(standardClauses)
      .where(eq(standardClauses.docId, docId))
      .orderBy(standardClauses.position);
    expect(clauses).toHaveLength(3);
    // Partition invariant: the section IS exactly its clauses, in order.
    expect(after!.content).toBe(clauses.map((c) => c.body).join("\n\n"));
    expect(after!.preamble).toBeNull();
    // Allocate-once cl-N: unique, contiguous from 1 for a fresh doc.
    expect(clauses.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(clauses.map((c) => c.position)).toEqual([1, 2, 3]);
  });

  it("backup + restore returns standards to the exact pre-migration state (ac-6, ac-15)", async () => {
    tagAc(AC(6));
    tagAc(AC(15));
    const { memexId, docId, sectionId, content } = await seedStandard();

    await backupStandards();
    await decomposeAllStandards({ memexId, translate: fakeTranslate });
    expect(
      (await db.select().from(standardClauses).where(eq(standardClauses.docId, docId))).length,
    ).toBe(3);

    await restoreStandardsFromBackup({ memexId });

    const restored = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
    expect(restored!.content).toBe(content); // exact original bytes
    expect(restored!.preamble).toBeNull(); // back to not-decomposed
    expect(
      (await db.select().from(standardClauses).where(eq(standardClauses.docId, docId))).length,
    ).toBe(0); // clauses removed
  });

  it("validation flags a section whose content no longer equals its clauses (ac-16)", async () => {
    tagAc(AC(16));
    const { memexId, sectionId } = await seedStandard();

    await decomposeAllStandards({ memexId, translate: fakeTranslate });

    // Honest decomposition: partition holds, nothing empty.
    const ok = await validateClausePartition({ memexId });
    expect(ok.contentMismatch).not.toContain(sectionId);
    expect(ok.emptySections).toHaveLength(0);
    expect(ok.checked).toBe(1);

    // Tamper the stored content so it diverges from the clause join.
    await db.update(docSections).set({ content: "TAMPERED" }).where(eq(docSections.id, sectionId));
    const drifted = await validateClausePartition({ memexId });
    expect(drifted.contentMismatch).toContain(sectionId); // detected → migration would abort
  });

  it("retries a transient translate failure and still decomposes (migration resilience)", async () => {
    const { memexId, docId } = await seedStandard();
    let calls = 0;
    const flakyOnce: TranslateFn = async (content) => {
      calls += 1;
      if (calls === 1) throw new Error("simulated 529 overloaded");
      return fakeTranslate(content);
    };

    const report = await decomposeAllStandards({ memexId, translate: flakyOnce });

    expect(report.sectionsDecomposed).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2); // first attempt threw, retried
    const clauses = await db.select().from(standardClauses).where(eq(standardClauses.docId, docId));
    expect(clauses.length).toBeGreaterThan(0); // decomposition still landed
  });

  it("introduces no per-clause embedding; embedding stays one-per-section (ac-14)", async () => {
    tagAc(AC(14));
    const cols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'standard_clauses' AND column_name LIKE 'embedding%'
    `)) as unknown as { column_name: string }[];
    expect(cols.length).toBe(0);
  });
});
