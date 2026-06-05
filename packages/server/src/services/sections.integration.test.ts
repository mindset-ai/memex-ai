import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections } from "../db/schema.js";
import { createDocDraft, getDoc } from "./documents.js";
import {
  addSection,
  updateSection,
  splitSection,
  retitleSection,
  deleteSection,
  restoreSection,
} from "./sections.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";
import { bus, type ChangeAction } from "./bus.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-107";
const SPEC150 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-150/acs/ac-${n}`;

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});


let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("addSection", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Section Test Doc", "Initial purpose");
    docId = doc.id;
    createdDocIds.push(docId);
  });

  it("adds a section with the next seq number", async () => {
    const section = await addSection(memexId, docId, "scope", "Scope content");

    expect(section.docId).toBe(docId);
    expect(section.sectionType).toBe("scope");
    expect(section.content).toBe("Scope content");
    expect(section.title).toBe("Scope");
    expect(section.seq).toBe(2); // purpose is seq 1
  });

  it("auto-capitalises sectionType as title when no title given", async () => {
    const section = await addSection(memexId, docId, "risks", "Risk content");
    expect(section.title).toBe("Risks");
  });

  it("uses explicit title when provided", async () => {
    const section = await addSection(memexId, docId, "custom", "Content", "My Custom Title");
    expect(section.title).toBe("My Custom Title");
  });

  it("throws NotFoundError for non-existent doc", async () => {
    await expect(
      addSection(memexId, "00000000-0000-0000-0000-000000000000", "scope", "Content")
    ).rejects.toThrow(NotFoundError);
  });

  // t-3: the (docId, sectionType) unique constraint must surface as a readable
  // ValidationError, not a raw Postgres "23505" message — the agent needs to
  // recognise it and pick a different identifier.
  it("rejects duplicate sectionType with a readable ValidationError", async () => {
    const doc = await createDocDraft(memexId, "Dup section test", "Initial purpose");
    createdDocIds.push(doc.id);

    await addSection(memexId, doc.id, "design", "First design content");

    await expect(
      addSection(memexId, doc.id, "design", "Second design content")
    ).rejects.toThrow(ValidationError);

    await expect(
      addSection(memexId, doc.id, "design", "Second design content")
    ).rejects.toThrow(/already exists/i);
  });
});

describe("updateSection", () => {
  let sectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Update Test Doc", "Original content");
    createdDocIds.push(doc.id);
    sectionId = doc.sections[0].id;
  });

  it("updates section content", async () => {
    const updated = await updateSection(memexId, sectionId, "Updated content");

    expect(updated.content).toBe("Updated content");
    expect(updated.id).toBe(sectionId);
  });

  it("updates the updatedAt timestamp", async () => {
    const before = new Date();
    const updated = await updateSection(memexId, sectionId, "Newer content");

    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000
    );
  });

  it("throws NotFoundError for non-existent section", async () => {
    await expect(
      updateSection(memexId, "00000000-0000-0000-0000-000000000000", "Content")
    ).rejects.toThrow(NotFoundError);
  });
});

// ── spec-106: writable section metadata (sectionType + description) ──────────
// ac-9: existing `sectionType` is writable via update_section and travels in the
//       read surface (get_doc).
// ac-10: new nullable `description` column writes through add_section /
//        update_section and travels in get_doc the same way.
const SPEC_106 = "mindset-prod/memex-building-itself/specs/spec-106";

describe("section metadata (spec-106 ac-9, ac-10)", () => {
  let docId: string;
  let sectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Metadata Test", "Body content");
    docId = doc.id;
    createdDocIds.push(docId);
    sectionId = doc.sections[0].id;
  });

  it("update_section writes a new sectionType (ac-9)", async () => {
    tagAc(`${SPEC_106}/acs/ac-9`);
    const updated = await updateSection(memexId, sectionId, "New body", {
      sectionType: "scope",
    });
    expect(updated.sectionType).toBe("scope");
    expect(updated.content).toBe("New body");
  });

  it("update_section writes a description (ac-10)", async () => {
    tagAc(`${SPEC_106}/acs/ac-10`);
    const updated = await updateSection(memexId, sectionId, "Body again", {
      description: "What this section captures",
    });
    expect(updated.description).toBe("What this section captures");
  });

  it("leaves sectionType/description unchanged when metadata omitted (ac-9, ac-10)", async () => {
    tagAc(`${SPEC_106}/acs/ac-9`);
    tagAc(`${SPEC_106}/acs/ac-10`);
    const before = await db.query.docSections.findFirst({
      where: eq(docSections.id, sectionId),
    });
    const updated = await updateSection(memexId, sectionId, "Content only edit");
    expect(updated.sectionType).toBe(before!.sectionType);
    expect(updated.description).toBe(before!.description);
  });

  it("clears the description when explicitly set to null (ac-10)", async () => {
    tagAc(`${SPEC_106}/acs/ac-10`);
    await updateSection(memexId, sectionId, "Body", { description: "temp" });
    const updated = await updateSection(memexId, sectionId, "Body", {
      description: null,
    });
    expect(updated.description).toBeNull();
  });

  it("surfaces a readable ValidationError on a colliding sectionType change (ac-9)", async () => {
    tagAc(`${SPEC_106}/acs/ac-9`);
    const doc = await createDocDraft(memexId, "Collision Test", "Body");
    createdDocIds.push(doc.id);
    const first = doc.sections[0].id;
    await addSection(memexId, doc.id, "operations", "Ops content");

    await expect(
      updateSection(memexId, first, "Body", { sectionType: "operations" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      updateSection(memexId, first, "Body", { sectionType: "operations" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("add_section accepts an optional description (ac-10)", async () => {
    tagAc(`${SPEC_106}/acs/ac-10`);
    const section = await addSection(
      memexId,
      docId,
      "design",
      "Design content",
      "Design",
      "How the thing is built",
    );
    expect(section.description).toBe("How the thing is built");
  });

  it("add_section leaves description NULL when omitted (ac-10)", async () => {
    tagAc(`${SPEC_106}/acs/ac-10`);
    const section = await addSection(memexId, docId, "rollout", "Rollout content");
    expect(section.description).toBeNull();
  });

  it("sectionType + description travel in get_doc output (ac-9, ac-10)", async () => {
    tagAc(`${SPEC_106}/acs/ac-9`);
    tagAc(`${SPEC_106}/acs/ac-10`);
    const doc = await createDocDraft(memexId, "Read Surface Test", "Body");
    createdDocIds.push(doc.id);
    await addSection(
      memexId,
      doc.id,
      "architecture",
      "Arch content",
      "Architecture",
      "The component wiring",
    );

    const fetched = await getDoc(memexId, doc.id);
    const arch = fetched.sections.find((s) => s.sectionType === "architecture");
    expect(arch).toBeDefined();
    expect(arch!.sectionType).toBe("architecture");
    expect(arch!.description).toBe("The component wiring");
  });
});

describe("splitSection", () => {
  it("splits a section at markdown headings", async () => {
    const doc = await createDocDraft(memexId, "Split Test", "placeholder");
    createdDocIds.push(doc.id);

    // Replace the purpose section content with headings
    await updateSection(memexId, 
      doc.sections[0].id,
      "# Part One\nFirst content.\n# Part Two\nSecond content."
    );

    const result = await splitSection(memexId, doc.sections[0].id);

    expect(result.length).toBe(2);
    expect(result[0].content).toContain("First content.");
    expect(result[1].content).toContain("Second content.");
    expect(result[0].seq).toBe(1);
    expect(result[1].seq).toBe(2);
  });

  it("throws ValidationError when no headings to split on", async () => {
    const doc = await createDocDraft(memexId, "No Split", "Just plain text, no headings");
    createdDocIds.push(doc.id);

    await expect(splitSection(memexId, doc.sections[0].id)).rejects.toThrow(
      ValidationError
    );
  });

  it("throws NotFoundError for non-existent section", async () => {
    await expect(
      splitSection(memexId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });

  it("shifts the DISPLAY position of subsequent sections; identity seq is frozen (spec-150 dec-2)", async () => {
    tagAc(SPEC150(13));
    const doc = await createDocDraft(memexId, "Shift Test", "placeholder");
    createdDocIds.push(doc.id);

    // Add a second section (scope) at position 2.
    const scope = await addSection(memexId, doc.id, "scope", "Scope content");

    // Replace purpose (position 1) with splittable content, then split it in two.
    await updateSection(memexId, doc.sections[0].id, "# A\nContent A\n# B\nContent B");
    await splitSection(memexId, doc.sections[0].id);

    // Order by DISPLAY position (spec-150: seq is identity, position is display order).
    const fresh = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, doc.id))
      .orderBy(docSections.position);

    expect(fresh).toHaveLength(3);
    // Display order: the original part, its new sibling, then the pre-existing scope
    // pushed to the end — positions contiguous.
    expect(fresh.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(fresh[2].sectionType).toBe("scope");
    // scope's IDENTITY seq is untouched by the split (only its display position moved).
    expect(fresh[2].seq).toBe(scope.seq);
  });
});

// ── spec-107: retitle_section (dec-1, ac-6) ──────────────────────────────
describe("retitleSection (spec-107 ac-6)", () => {
  let docId: string;
  let sectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Retitle Test", "Body content");
    docId = doc.id;
    createdDocIds.push(docId);
    sectionId = doc.sections[0].id;
  });

  it("changes the heading without touching content or key", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const before = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });

    const updated = await retitleSection(memexId, sectionId, "Considerations");

    expect(updated.title).toBe("Considerations");
    expect(updated.content).toBe(before!.content); // content untouched
    expect(updated.sectionType).toBe(before!.sectionType); // key untouched when omitted
  });

  it("rekeys the sectionType when supplied", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const updated = await retitleSection(
      memexId,
      sectionId,
      "Architecture & Security",
      "architecture",
    );
    expect(updated.title).toBe("Architecture & Security");
    expect(updated.sectionType).toBe("architecture");
  });

  it("surfaces a readable ValidationError on sectionType collision", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    // Add a second section, then try to rekey the first onto its type.
    await addSection(memexId, docId, "operations", "Ops content");

    await expect(
      retitleSection(memexId, sectionId, "Clash", "operations"),
    ).rejects.toThrow(ValidationError);
    await expect(
      retitleSection(memexId, sectionId, "Clash", "operations"),
    ).rejects.toThrow(/already exists/i);
  });

  it("404s (NotFoundError) for a cross-memex / unknown section", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const other = await makeTestMemex();
    await expect(
      retitleSection(other, sectionId, "Sneaky"),
    ).rejects.toThrow(NotFoundError);
  });
});

// ── spec-107: delete_section soft-delete + resequence (dec-2/dec-3, ac-7/ac-8) ──
describe("deleteSection (spec-107 ac-7, ac-8)", () => {
  it("soft-deletes: sets status=deleted and captures previousStatus", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const doc = await createDocDraft(memexId, "Soft Delete Test", "Purpose");
    createdDocIds.push(doc.id);
    const target = await addSection(memexId, doc.id, "scope", "Scope");

    const deleted = await deleteSection(memexId, target.id);

    expect(deleted.status).toBe("deleted");
    expect(deleted.previousStatus).toBe("active");

    // Row still exists in the table (soft, not hard).
    const row = await db.query.docSections.findFirst({ where: eq(docSections.id, target.id) });
    expect(row).toBeDefined();
    expect(row!.status).toBe("deleted");
  });

  it("hides the deleted section from getDoc", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const doc = await createDocDraft(memexId, "GetDoc Filter Test", "Purpose");
    createdDocIds.push(doc.id);
    const scope = await addSection(memexId, doc.id, "scope", "Scope");

    await deleteSection(memexId, scope.id);

    const fetched = await getDoc(memexId, doc.id);
    const types = fetched.sections.map((s) => s.sectionType);
    expect(types).not.toContain("scope");
  });

  it("rejects a double-delete with a ValidationError", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const doc = await createDocDraft(memexId, "Double Delete Test", "Purpose");
    createdDocIds.push(doc.id);
    const scope = await addSection(memexId, doc.id, "scope", "Scope");

    await deleteSection(memexId, scope.id);
    await expect(deleteSection(memexId, scope.id)).rejects.toThrow(ValidationError);
  });

  it("404s for a cross-memex section", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const doc = await createDocDraft(memexId, "XMemex Delete Test", "Purpose");
    createdDocIds.push(doc.id);
    const scope = await addSection(memexId, doc.id, "scope", "Scope");
    const other = await makeTestMemex();

    await expect(deleteSection(other, scope.id)).rejects.toThrow(NotFoundError);
  });

  it("freezes identity seq and resequences the DISPLAY position to stay contiguous (spec-107 ac-8 + spec-150 ac-11/ac-13)", async () => {
    tagAc(`${SPEC}/acs/ac-8`); // spec-107 intent: rendered numbering stays contiguous (now carried by position)
    tagAc(SPEC150(11)); // spec-150: the identity seq of survivors is frozen, never resequenced
    tagAc(SPEC150(13)); // spec-150: display order (position) is separate from identity (seq)
    // Doc starts with purpose @ seq/position 1. Add three → seq/position 2,3,4.
    const doc = await createDocDraft(memexId, "Resequence Test", "Purpose");
    createdDocIds.push(doc.id);
    const a = await addSection(memexId, doc.id, "a", "A"); // seq/pos 2
    const b = await addSection(memexId, doc.id, "b", "B"); // seq/pos 3
    const c = await addSection(memexId, doc.id, "c", "C"); // seq/pos 4

    // Delete the middle one (a @ seq 2).
    await deleteSection(memexId, a.id);

    const live = (
      await db.select().from(docSections).where(eq(docSections.docId, doc.id))
    ).filter((s) => s.status !== "deleted");

    // IDENTITY seq is FROZEN: survivors keep their original seqs; a's seq (2) is gone,
    // leaving a gap. No renumber of identity — so every `s-N` ref stays valid.
    const bySeq = [...live].sort((x, y) => x.seq - y.seq);
    expect(bySeq.map((s) => s.seq)).toEqual([1, 3, 4]); // gap at 2, identity preserved
    expect(b.seq).toBe(3);
    expect(c.seq).toBe(4);

    // DISPLAY position IS resequenced contiguous (spec-107's intent, now on position).
    const byPos = [...live].sort((x, y) => x.position - y.position);
    expect(byPos.map((s) => s.position)).toEqual([1, 2, 3]); // contiguous display, no gap
    expect(byPos.map((s) => s.sectionType).slice(1)).toEqual(["b", "c"]);
  });

  it("adding a section leaves existing sections' identity seq unchanged (spec-150 ac-12)", async () => {
    tagAc(SPEC150(12));
    const doc = await createDocDraft(memexId, "Append Test", "Purpose");
    createdDocIds.push(doc.id);
    const a = await addSection(memexId, doc.id, "a", "A");
    const b = await addSection(memexId, doc.id, "b", "B");
    const seqsBefore = [doc.sections[0].seq, a.seq, b.seq];

    const c = await addSection(memexId, doc.id, "c", "C");

    // New section's seq is allocate-once MAX+1; no existing seq changed.
    expect(c.seq).toBe(Math.max(...seqsBefore) + 1);
    const all = await db.select().from(docSections).where(eq(docSections.docId, doc.id));
    const seqById = new Map(all.map((s) => [s.id, s.seq]));
    expect(seqById.get(doc.sections[0].id)).toBe(doc.sections[0].seq);
    expect(seqById.get(a.id)).toBe(a.seq);
    expect(seqById.get(b.id)).toBe(b.seq);
  });

  it("emits one bus event per changed section (composite mutation, ac-8)", async () => {
    tagAc(`${SPEC}/acs/ac-8`);
    const doc = await createDocDraft(memexId, "Bus Emit Test", "Purpose");
    createdDocIds.push(doc.id);
    const a = await addSection(memexId, doc.id, "a", "A"); // seq 2
    await addSection(memexId, doc.id, "b", "B"); // seq 3
    await addSection(memexId, doc.id, "c", "C"); // seq 4

    const actions: ChangeAction[] = [];
    const unsubscribe = bus.subscribe(
      { memexId, docId: doc.id, entity: "section" },
      (e) => actions.push(e.action),
    );

    // Deleting a @ seq 2 → 1 delete + 2 resequenced (b, c) = 3 events.
    await deleteSection(memexId, a.id);
    unsubscribe();

    expect(actions.filter((x) => x === "deleted")).toHaveLength(1);
    expect(actions.filter((x) => x === "updated")).toHaveLength(2);
    expect(actions).toHaveLength(3);
  });
});

// ── spec-107: restoreSection (dec-2, ac-7) ───────────────────────────────
describe("restoreSection (spec-107 ac-7)", () => {
  it("restores a deleted section to its previousStatus", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const doc = await createDocDraft(memexId, "Restore Test", "Purpose");
    createdDocIds.push(doc.id);
    const scope = await addSection(memexId, doc.id, "scope", "Scope");

    await deleteSection(memexId, scope.id);
    const restored = await restoreSection(memexId, scope.id);

    expect(restored.status).toBe("active");
    expect(restored.previousStatus).toBeNull();

    // Now visible again in getDoc.
    const fetched = await getDoc(memexId, doc.id);
    expect(fetched.sections.map((s) => s.sectionType)).toContain("scope");
  });

  it("rejects restoring a section that is not deleted", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const doc = await createDocDraft(memexId, "Restore Guard Test", "Purpose");
    createdDocIds.push(doc.id);
    const scope = await addSection(memexId, doc.id, "scope", "Scope");

    await expect(restoreSection(memexId, scope.id)).rejects.toThrow(ValidationError);
  });
});
