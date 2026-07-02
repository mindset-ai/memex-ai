// spec-300 t-1: the Skills data layer — docType 'skill' in `documents` (dec-16),
// the `description` dispatch key (dec-12), skill-N handle minting (dec-13), and the
// `skill_files` auxiliary-file manifest (dec-18/dec-19). No bespoke skills table.
import { describe, it, expect, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { docTypePath } from "@memex/shared";
import { db } from "../db/connection.js";
import { documents, skillFiles } from "../db/schema.js";
import { DOC_TYPES } from "../types/roles.js";
import { makeTestMemex } from "./test-helpers.js";
import { createDocDraft, nextSkillHandle } from "./documents.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-300";
const ac = (n: number) => `${SPEC}/acs/ac-${n}`;

describe("spec-300 t-1: skills data layer", () => {
  const createdDocIds: string[] = [];

  afterEach(async () => {
    if (createdDocIds.length) {
      // FK ON DELETE CASCADE removes any skill_files rows with the doc.
      await db.delete(documents).where(inArray(documents.id, createdDocIds));
      createdDocIds.length = 0;
    }
  });

  it("registers 'skill' as a distinct docType, not a bespoke table (dec-1/dec-16)", () => {
    tagAc(ac(23)); // dec-1 — skill distinct from standard
    tagAc(ac(38)); // dec-16 — skill is a documents docType, not a separate table
    expect(DOC_TYPES).toContain("skill");
    // the index-0/1 pins that services/standards*.ts assert must survive the append
    expect(DOC_TYPES[0]).toBe("spec");
    expect(DOC_TYPES[1]).toBe("standard");
  });

  it("maps docType 'skill' to the 'skills' ref segment (dec-13)", () => {
    tagAc(ac(35));
    expect(docTypePath("skill")).toBe("skills");
  });

  it("mints a skill-N handle for a skill document (dec-13/dec-16)", async () => {
    tagAc(ac(35)); // skill-N handle
    tagAc(ac(38)); // stored as a `documents` row
    const memexId = await makeTestMemex("t1skill");
    const doc = await createDocDraft(memexId, "how-we-do-buttons", "body", "skill");
    createdDocIds.push(doc.id);

    expect(doc.docType).toBe("skill");
    expect(doc.handle).toMatch(/^skill-\d+$/);

    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.docType).toBe("skill");

    // a second skill in the same Memex advances the independent skill sequence
    expect(await nextSkillHandle(memexId)).toBe("skill-2");
  });

  it("persists the nullable description dispatch key (dec-12)", async () => {
    tagAc(ac(34));
    const memexId = await makeTestMemex("t1desc");
    const doc = await createDocDraft(memexId, "chart-house-style", "body", "skill");
    createdDocIds.push(doc.id);

    await db
      .update(documents)
      .set({ description: "Use when adding a chart in our house style." })
      .where(eq(documents.id, doc.id));

    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row.description).toBe("Use when adding a chart in our house style.");
  });

  it("stores auxiliary files as a skill_files manifest — bytes not required inline (dec-18/dec-19)", async () => {
    tagAc(ac(39));
    const memexId = await makeTestMemex("t1files");
    const doc = await createDocDraft(memexId, "sdk-embed-starter", "body", "skill");
    createdDocIds.push(doc.id);

    // a text auxiliary file may live inline
    const [inlineFile] = await db
      .insert(skillFiles)
      .values({
        skillDocId: doc.id,
        path: "templates/index.html",
        purpose: "Base HTML the agent copies when scaffolding.",
        contentType: "text/html",
        size: 128,
        checksum: "sha256:aaa",
        storageKind: "inline",
        textContent: "<!doctype html>",
      })
      .returning();
    expect(inlineFile.path).toBe("templates/index.html");
    expect(inlineFile.storageKind).toBe("inline");

    // a binary auxiliary file references the blob store, never Postgres bytes
    const [binaryFile] = await db
      .insert(skillFiles)
      .values({
        skillDocId: doc.id,
        path: "assets/font.woff2",
        contentType: "font/woff2",
        size: 4096,
        checksum: "sha256:bbb",
        storageKind: "bucket",
        blobUri: "gcs://memex-skills/x/font.woff2",
      })
      .returning();
    expect(binaryFile.storageKind).toBe("bucket");
    expect(binaryFile.blobUri).toContain("font.woff2");

    // storage_kind is a closed set — the CHECK constraint rejects anything else
    await expect(
      db.insert(skillFiles).values({
        skillDocId: doc.id,
        path: "bad-kind",
        contentType: "text/plain",
        size: 1,
        checksum: "sha256:ccc",
        storageKind: "nonsense",
      }),
    ).rejects.toThrow();
  });
});
