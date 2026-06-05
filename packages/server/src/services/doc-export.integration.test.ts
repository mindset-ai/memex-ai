import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { updateSection } from "./sections.js";
import { addComment, addAnchoredComment } from "./comments.js";
import { buildDocExportForm } from "./doc-export.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100 ac-5: a spec can be exported as markdown with every comment thread
// expanded inline at its anchor, lossless enough to paste into an external LLM.
const AC_SCOPE_EXPORT = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-5";

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

describe("buildDocExportForm", () => {
  it("expands an anchored comment inline and appends a floating one, losslessly", async () => {
    tagAc(AC_SCOPE_EXPORT);
    const doc = await createDocDraft(memexId, "Export Doc", "Purpose");
    createdDocIds.push(doc.id);
    const section = doc.sections[0];
    const source = "The proxy emits llm_call events when a call is made.";
    await updateSection(memexId, section.id, source);

    const anchored = await addAnchoredComment(
      memexId,
      section.id,
      "Wic",
      "Streaming chunks don't fire llm_call.",
      source.indexOf(" when a call"),
      { type: "issue" },
    );
    await addComment(memexId, section.id, "Barrie", "General floating note.", {
      type: "discussion",
    });

    const out = await buildDocExportForm(memexId, doc.id);

    // Doc + section headings present.
    expect(out).toContain("# Export Doc");
    // Anchored comment expanded inline at its marker position.
    expect(out).toContain(`<!-- comment-start c-${anchored.seq} -->`);
    expect(out).toContain("> Streaming chunks don't fire llm_call.");
    expect(out).toContain(`events<!-- comment-start c-${anchored.seq} -->`);
    // Floating comment preserved (appended) — nothing lost.
    expect(out).toContain("> General floating note.");
    // No raw marker glyph leaks into the export.
    expect(out).not.toMatch(/\[\^c-\d+\]/);
  });

  it("renders a doc with no comments as its plain section bodies", async () => {
    const doc = await createDocDraft(memexId, "Plain Doc", "Just purpose text.");
    createdDocIds.push(doc.id);
    const out = await buildDocExportForm(memexId, doc.id);
    expect(out).toContain("# Plain Doc");
    expect(out).not.toContain("comment-start");
  });
});
