// b-36 T-2 — per-doc seq allocator for sections + comments.
//
// Covers:
//   1. Sequential allocation: addSection on the same doc returns monotonically
//      increasing seq values.
//   2. Concurrent allocation: Promise.all of two inserts on the same doc both
//      succeed and end up with distinct seq values (withSeqRetry recovers from
//      the unique-violation race).
//   3. Backfill invariant: every seeded (doc_id, seq) tuple in doc_sections and
//      doc_comments is unique (the migration's deterministic backfill held).

import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/connection.js";
import { docSections, docComments, tasks, decisions, documents } from "../../db/schema.js";
import { makeTestMemex } from "../test-helpers.js";
import { createDocDraft } from "../documents.js";
import { addSection } from "../sections.js";
import { addComment } from "../comments.js";
import { createTask } from "../tasks.js";
import { createDecision, proposeDecision } from "../decisions.js";

describe("per-doc seq allocator (b-36 T-2)", () => {
  // ── Sequential allocation: addSection ──────────────────────────────────
  it("addSection mints monotonically increasing seq under the same doc", async () => {
    const memexId = await makeTestMemex("seq-seq");
    const doc = await createDocDraft(memexId, "Seq doc", "Purpose");

    const s1 = await addSection(memexId, doc.id, "context", "first body");
    const s2 = await addSection(memexId, doc.id, "rationale", "second body");
    const s3 = await addSection(memexId, doc.id, "acceptance", "third body");

    // createDocDraft has already inserted at least one seed section (the
    // overview/purpose one) at seq=1, so addSection lands at >=2 — what we
    // care about is strict monotonicity, not absolute values.
    expect(s1.seq).toBeGreaterThan(0);
    expect(s2.seq).toBe(s1.seq + 1);
    expect(s3.seq).toBe(s2.seq + 1);
  });

  // ── Concurrent allocation: sections ─────────────────────────────────────
  it("two concurrent addSection inserts under the same doc both succeed with distinct seqs", async () => {
    const memexId = await makeTestMemex("seq-concur-s");
    const doc = await createDocDraft(memexId, "Concur doc", "Purpose");

    // Distinct sectionTypes so the (doc_id, section_type) unique constraint
    // never fires — only the (doc_id, seq) one is in play.
    const [a, b] = await Promise.all([
      addSection(memexId, doc.id, "context-a", "a body"),
      addSection(memexId, doc.id, "context-b", "b body"),
    ]);

    expect(a.seq).not.toBe(b.seq);

    // Verify both are visible and unique-constraint-clean against the DB.
    const rows = await db
      .select({ seq: docSections.seq })
      .from(docSections)
      .where(eq(docSections.docId, doc.id));
    const seqs = rows.map((r) => r.seq);
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(seqs.length);
  });

  // ── Concurrent allocation: comments ─────────────────────────────────────
  it("two concurrent addComment inserts under the same doc both succeed with distinct seqs", async () => {
    const memexId = await makeTestMemex("seq-concur-c");
    const docRaw = await createDocDraft(memexId, "Comment doc", "Purpose");
    const sections = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, docRaw.id));
    const sectionId = sections[0].id;

    const [c1, c2] = await Promise.all([
      addComment(memexId, sectionId, "Alice", "first"),
      addComment(memexId, sectionId, "Bob", "second"),
    ]);

    expect(c1.docId).toBe(docRaw.id);
    expect(c2.docId).toBe(docRaw.id);
    expect(c1.seq).not.toBe(c2.seq);
    expect(c1.seq).toBeGreaterThan(0);
    expect(c2.seq).toBeGreaterThan(0);

    // Confirm DB sees both rows with unique (doc_id, seq).
    const rows = await db
      .select({ seq: docComments.seq })
      .from(docComments)
      .where(eq(docComments.docId, docRaw.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(2);
  });

  // ── Concurrent allocation: tasks (b-38 F-3) ─────────────────────────────
  it("two concurrent createTask inserts under the same doc both succeed with distinct seqs", async () => {
    const memexId = await makeTestMemex("seq-concur-t");
    const doc = await createDocDraft(memexId, "Tasks doc", "Purpose");

    const [t1, t2] = await Promise.all([
      createTask(memexId, doc.id, "Task A", "first"),
      createTask(memexId, doc.id, "Task B", "second"),
    ]);

    expect(t1.seq).not.toBe(t2.seq);
    expect(t1.seq).toBeGreaterThan(0);
    expect(t2.seq).toBeGreaterThan(0);

    const rows = await db
      .select({ seq: tasks.seq })
      .from(tasks)
      .where(eq(tasks.docId, doc.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(2);
  });

  // ── Concurrent allocation: decisions — createDecision (b-38 F-3) ───────
  it("two concurrent createDecision inserts under the same doc both succeed with distinct seqs", async () => {
    const memexId = await makeTestMemex("seq-concur-d");
    const doc = await createDocDraft(memexId, "Decisions doc", "Purpose");

    const [d1, d2] = await Promise.all([
      createDecision(memexId, doc.id, "Choice A?"),
      createDecision(memexId, doc.id, "Choice B?"),
    ]);

    expect(d1.seq).not.toBe(d2.seq);
    expect(d1.seq).toBeGreaterThan(0);
    expect(d2.seq).toBeGreaterThan(0);

    const rows = await db
      .select({ seq: decisions.seq })
      .from(decisions)
      .where(eq(decisions.docId, doc.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(2);
  });

  // ── Concurrent allocation: decisions — proposeDecision (b-38 F-3) ──────
  it("two concurrent proposeDecision inserts under the same doc both succeed with distinct seqs", async () => {
    const memexId = await makeTestMemex("seq-concur-pd");
    const doc = await createDocDraft(memexId, "Propose doc", "Purpose");

    const [d1, d2] = await Promise.all([
      proposeDecision(memexId, doc.id, { title: "Candidate A?" }),
      proposeDecision(memexId, doc.id, { title: "Candidate B?" }),
    ]);

    expect(d1.seq).not.toBe(d2.seq);
  });

  // ── Concurrent allocation: document handles — createDocDraft (spec-187) ──
  // The handle mint (COALESCE(MAX(spec-N))+1) raced under concurrent creates in
  // the same memex and 23505'd on `documents_memex_id_handle_unique` — exactly
  // the b-38 F-3 race, which never reached documents until spec-187. Six
  // concurrent creates is the worst case the withSeqRetry cap (12) is sized
  // for; this is also the shape that flaked path-routing.api.test.ts in CI.
  it("six concurrent createDocDraft calls in the same memex all succeed with distinct handles", async () => {
    const memexId = await makeTestMemex("seq-concur-doc");

    const docs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createDocDraft(memexId, `Concurrent spec ${i}`, "Purpose"),
      ),
    );

    const handles = docs.map((d) => d.handle);
    expect(new Set(handles).size).toBe(6);
    for (const h of handles) expect(h).toMatch(/^spec-\d+$/);

    const rows = await db
      .select({ handle: documents.handle })
      .from(documents)
      .where(eq(documents.memexId, memexId));
    expect(new Set(rows.map((r) => r.handle)).size).toBe(rows.length);
  });

  // ── Migration invariant: existing rows ──────────────────────────────────
  it("seeded doc_sections have unique (doc_id, seq) — backfill held", async () => {
    const dupes = await db.execute(sql`
      SELECT doc_id, seq, COUNT(*) AS n
        FROM doc_sections
       GROUP BY doc_id, seq
       HAVING COUNT(*) > 1
    `);
    expect(dupes.length).toBe(0);
  });

  it("seeded doc_comments have unique (doc_id, seq) — backfill held", async () => {
    const dupes = await db.execute(sql`
      SELECT doc_id, seq, COUNT(*) AS n
        FROM doc_comments
       GROUP BY doc_id, seq
       HAVING COUNT(*) > 1
    `);
    expect(dupes.length).toBe(0);
  });

  it("every doc_comment has a non-null doc_id matching its target's doc_id", async () => {
    // For section-targeted comments, doc_id must equal the target section's doc_id.
    const sectionMismatch = await db.execute(sql`
      SELECT c.id
        FROM doc_comments c
        JOIN doc_sections s ON s.id = c.section_id
       WHERE c.section_id IS NOT NULL
         AND c.doc_id <> s.doc_id
    `);
    expect(sectionMismatch.length).toBe(0);

    // Same for decision-targeted comments.
    const decisionMismatch = await db.execute(sql`
      SELECT c.id
        FROM doc_comments c
        JOIN decisions d ON d.id = c.decision_id
       WHERE c.decision_id IS NOT NULL
         AND c.doc_id <> d.doc_id
    `);
    expect(decisionMismatch.length).toBe(0);

    // Same for task-targeted comments.
    const taskMismatch = await db.execute(sql`
      SELECT c.id
        FROM doc_comments c
        JOIN tasks t ON t.id = c.task_id
       WHERE c.task_id IS NOT NULL
         AND c.doc_id <> t.doc_id
    `);
    expect(taskMismatch.length).toBe(0);
  });
});
