import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, docComments } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { updateSection } from "./sections.js";
import { addAnchoredComment } from "./comments.js";
import { applyCommentAction, undoCommentAction } from "./comment-actions.js";
import { markerEndGlyph } from "./geo-anchor.js";
import { ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100: system-seeded weakness comments carry action buttons. Address
// invokes the agent to edit in place (apply-with-undo); Dismiss resolves.
const AC_DEC2_ACTION = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-8";
const AC_SCOPE_ADDRESS = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-3";
const AC_SYSTEM_SIDE = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-11";

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

async function content(sectionId: string): Promise<string> {
  const row = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
  return row!.content;
}

// Seed a system-authored weakness comment (the shape ingestion produces):
// agent-sourced, anchored, carrying Address/Dismiss buttons.
async function seedWeaknessComment(sectionId: string, offset: number) {
  return addAnchoredComment(memexId, sectionId, "Memex", "This section is sparse on security.", offset, {
    source: "agent",
    type: "issue",
    actions: [
      { label: "Address", kind: "agent", prompt: "Expand the security considerations." },
      { label: "Dismiss", kind: "dismiss" },
    ],
  });
}

describe("applyCommentAction — Dismiss", () => {
  it("resolves the comment without invoking the agent", async () => {
    const doc = await createDocDraft(memexId, "DismissDoc", "Purpose");
    createdDocIds.push(doc.id);
    const section = doc.sections[0];
    await updateSection(memexId, section.id, "Security is handled. More prose here.");
    const seeded = await seedWeaknessComment(section.id, "Security is handled.".length);

    const runEdit = async () => {
      throw new Error("agent must not be called on Dismiss");
    };
    const result = await applyCommentAction(memexId, seeded.id, "Dismiss", { runEdit });

    expect(result.kind).toBe("dismiss");
    expect(result.comment.resolvedAt).not.toBeNull();
  });
});

describe("applyCommentAction — Address (agent edit, apply-with-undo)", () => {
  it("applies the agent edit in place, auto-resolves, removes the marker, records an audit", async () => {
    tagAc(AC_DEC2_ACTION);
    tagAc(AC_SYSTEM_SIDE);
    const doc = await createDocDraft(memexId, "AddressDoc", "Purpose");
    createdDocIds.push(doc.id);
    const section = doc.sections[0];
    await updateSection(memexId, section.id, "Security: minimal. Other content stays.");
    const seeded = await seedWeaknessComment(section.id, "Security: minimal.".length);

    // The marker was inserted into the source by the anchored create.
    expect(await content(section.id)).toContain(markerEndGlyph(seeded.seq));

    const expanded = "Security: minimal, now expanded with auth, encryption, and audit logging. Other content stays.";
    const runEdit = async () => expanded; // agent returns new storage-form content
    const result = await applyCommentAction(memexId, seeded.id, "Address", {
      runEdit,
      agentName: "Memex agent",
    });

    expect(result.kind).toBe("agent");
    // Edit landed in place.
    const now = await content(section.id);
    expect(now).toContain("auth, encryption, and audit logging");
    // This comment's own marker was removed on resolve.
    expect(now).not.toContain(markerEndGlyph(seeded.seq));
    // Comment auto-resolved.
    expect(result.comment.resolvedAt).not.toBeNull();
    expect(result.before).toContain("Security: minimal.");
    expect(result.after).toBe(expanded);
  });

  it("undoes cleanly: restores prior content (and the marker) and re-opens the comment", async () => {
    tagAc(AC_SCOPE_ADDRESS);
    const doc = await createDocDraft(memexId, "UndoDoc", "Purpose");
    createdDocIds.push(doc.id);
    const section = doc.sections[0];
    await updateSection(memexId, section.id, "Thin section. Tail stays.");
    const seeded = await seedWeaknessComment(section.id, "Thin section.".length);
    const before = await content(section.id);

    await applyCommentAction(memexId, seeded.id, "Address", {
      runEdit: async () => "Thin section, now thoroughly fleshed out. Tail stays.",
    });
    expect(await content(section.id)).toContain("thoroughly fleshed out");

    const reopened = await undoCommentAction(memexId, seeded.id);

    expect(await content(section.id)).toBe(before); // prior content + marker restored
    expect(await content(section.id)).toContain(markerEndGlyph(seeded.seq));
    expect(reopened.resolvedAt).toBeNull(); // comment re-opened
  });

  it("fails loudly and changes nothing if the agent would destroy another comment's marker", async () => {
    tagAc(AC_DEC2_ACTION);
    const doc = await createDocDraft(memexId, "PreserveDoc", "Purpose");
    createdDocIds.push(doc.id);
    const section = doc.sections[0];
    await updateSection(memexId, section.id, "First claim. Second claim here.");
    // Two anchored comments → two markers in the source.
    const other = await addAnchoredComment(memexId, section.id, "Wic", "note on first", "First claim.".length, {});
    const seeded = await seedWeaknessComment(section.id, "First claim. Second claim here.".length - 1);
    const before = await content(section.id);

    // Agent returns content that drops the OTHER comment's marker.
    const badOutput = "Rewritten with no markers at all.";
    await expect(
      applyCommentAction(memexId, seeded.id, "Address", { runEdit: async () => badOutput }),
    ).rejects.toThrow(ValidationError);

    // Nothing changed; both markers still present, the seeded comment still open.
    expect(await content(section.id)).toBe(before);
    expect(await content(section.id)).toContain(markerEndGlyph(other.seq));
    expect(await content(section.id)).toContain(markerEndGlyph(seeded.seq));
    const reread = await db.query.docComments.findFirst({
      where: eq(docComments.id, seeded.id),
    });
    expect(reread!.resolvedAt).toBeNull();
  });

  it("serializes concurrent agent actions on the same doc (no interleaving)", async () => {
    tagAc(AC_DEC2_ACTION);
    const doc = await createDocDraft(memexId, "SerializeDoc", "Purpose");
    createdDocIds.push(doc.id);
    const section = doc.sections[0];
    await updateSection(memexId, section.id, "Alpha point. Beta point.");
    const c1 = await seedWeaknessComment(section.id, "Alpha point.".length);
    const c2 = await seedWeaknessComment(section.id, "Alpha point. Beta point.".length - 1);

    let active = 0;
    let sawOverlap = false;
    const runEdit = async (input: { sectionContent: string }) => {
      active++;
      if (active > 1) sawOverlap = true;
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return input.sectionContent; // no-op edit (markers preserved)
    };

    await Promise.all([
      applyCommentAction(memexId, c1.id, "Address", { runEdit }),
      applyCommentAction(memexId, c2.id, "Address", { runEdit }),
    ]);

    expect(sawOverlap).toBe(false);
  });
});
