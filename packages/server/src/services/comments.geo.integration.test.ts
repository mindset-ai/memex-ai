import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, docComments } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  addComment,
  addAnchoredComment,
  deleteComment,
  isAnchored,
  isCommentOrphaned,
  markerGlyphFor,
} from "./comments.js";
import { updateSection } from "./sections.js";
import { markerEndGlyph, markerStartGlyph } from "./geo-anchor.js";
import { ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-100 implementation ACs (canonical refs route emissions to mindset-prod).
const AC_DEC1_ANCHOR = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-7";
const AC_DEC4_SNAPSHOT = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-10";
const AC_RESOLVE_DELETE = "mindset-prod/memex-building-itself/specs/spec-100/acs/ac-13";

async function sectionContent(sectionId: string): Promise<string> {
  const row = await db.query.docSections.findFirst({ where: eq(docSections.id, sectionId) });
  return row!.content;
}

// spec-100 (geo-comments): a comment can be anchored to a point in a section's
// markdown source. v0 adds three fields to the comment record:
//   - anchorSnippet: the snapshot of surrounding text captured at creation
//     (null => the comment is floating, the historic behaviour)
//   - audience:      reserved for v1+ attention routing; v0 always 'all'
//   - actions:       system-authored action buttons (Address/Dismiss); only
//                    permitted on source='agent' comments in v0.
// The marker glyph that rides in the section source is the comment's own
// `c-{seq}` handle expressed footnote-style: `[^c-{seq}]` (dec-1).

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

let memexId: string;
let sectionId: string;

beforeAll(async () => {
  memexId = await makeTestMemex();
  const doc = await createDocDraft(memexId, "Geo Comment Test Doc", "Purpose");
  createdDocIds.push(doc.id);
  sectionId = doc.sections[0].id;
});

describe("anchored comments — anchor snippet", () => {
  it("persists the anchor snippet and reports the comment as anchored", async () => {
    tagAc(AC_DEC4_SNAPSHOT); // dec-4: snapshot stored at creation
    const comment = await addComment(memexId, sectionId, "Wic", "This is wrong.", {
      type: "issue",
      anchor: { snippet: "The proxy emits llm_call events" },
    });

    expect(comment.anchorSnippet).toBe("The proxy emits llm_call events");
    expect(isAnchored(comment)).toBe(true);
  });

  it("defaults to a floating comment (null snippet) when no anchor is given", async () => {
    const comment = await addComment(memexId, sectionId, "Wic", "A floating note.");

    expect(comment.anchorSnippet).toBeNull();
    expect(isAnchored(comment)).toBe(false);
  });

  it("derives the canonical (end) marker glyph from the comment's own seq handle", async () => {
    tagAc(AC_DEC1_ANCHOR); // dec-1: marker is the comment's `[^c-{seq}e]` handle
    const comment = await addComment(memexId, sectionId, "Wic", "Anchored.", {
      anchor: { snippet: "some context" },
    });

    expect(markerGlyphFor(comment)).toBe(`[^c-${comment.seq}e]`);
  });

  it("rejects an anchor with an empty snippet", async () => {
    await expect(
      addComment(memexId, sectionId, "Wic", "Bad anchor", {
        anchor: { snippet: "   " },
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("anchored comments — audience (reserved)", () => {
  it("defaults audience to 'all'", async () => {
    const comment = await addComment(memexId, sectionId, "Wic", "Default audience.");
    expect(comment.audience).toBe("all");
  });

  it("accepts an explicit 'all' audience", async () => {
    const comment = await addComment(memexId, sectionId, "Wic", "Explicit all.", {
      audience: "all",
    });
    expect(comment.audience).toBe("all");
  });

  it("rejects a non-'all' audience in v0 (field is reserved)", async () => {
    // The type permits string[] (v1+ shape); v0's runtime guard rejects it.
    await expect(
      addComment(memexId, sectionId, "Wic", "Targeted.", { audience: ["00000000-0000-0000-0000-000000000111"] }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("anchored comments — action buttons", () => {
  it("persists agent-authored action buttons", async () => {
    const actions = [
      { label: "Address", kind: "agent", prompt: "Improve this section." },
      { label: "Dismiss", kind: "dismiss" },
    ];
    const comment = await addComment(memexId, sectionId, "Memex", "This section is sparse.", {
      type: "issue",
      source: "agent",
      anchor: { snippet: "Security considerations" },
      actions,
    });

    expect(comment.actions).toEqual(actions);
  });

  it("rejects actions on a human-authored comment (v0: humans discuss, systems act)", async () => {
    await expect(
      addComment(memexId, sectionId, "Wic", "I want a button.", {
        source: "human",
        actions: [{ label: "Address", kind: "agent", prompt: "do it" }],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an agent action of kind 'agent' with no prompt", async () => {
    await expect(
      addComment(memexId, sectionId, "Memex", "Broken action.", {
        source: "agent",
        actions: [{ label: "Address", kind: "agent" }],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("leaves actions null when none are supplied", async () => {
    const comment = await addComment(memexId, sectionId, "Wic", "No actions.");
    expect(comment.actions).toBeNull();
  });
});

describe("addAnchoredComment — marker insertion + snapshot + atomicity", () => {
  const SOURCE =
    "First sentence here. The proxy emits llm_call events when an outbound call is made. Third sentence.";
  let anchorSectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Anchored Flow Doc", "Purpose");
    createdDocIds.push(doc.id);
    anchorSectionId = doc.sections[0].id;
    await updateSection(memexId, anchorSectionId, SOURCE);
  });

  it("inserts a single end sentinel at the offset for a POINT anchor (no start)", async () => {
    tagAc(AC_DEC1_ANCHOR);
    const offset = SOURCE.indexOf(" when an outbound"); // just after "events"
    const comment = await addAnchoredComment(
      memexId,
      anchorSectionId,
      "Wic",
      "Streaming chunks don't fire llm_call.",
      offset,
      { type: "issue" },
    );

    const content = await sectionContent(anchorSectionId);
    expect(content).toContain(markerEndGlyph(comment.seq));
    // No start sentinel for a point anchor.
    expect(content).not.toContain(markerStartGlyph(comment.seq));
    // The glyph sits exactly where the offset pointed: right after "events".
    expect(content).toContain(`llm_call events${markerEndGlyph(comment.seq)} when an outbound`);
  });

  it("brackets the selection with start + end sentinels for a RANGE anchor", async () => {
    tagAc(AC_DEC1_ANCHOR);
    tagAc(AC_DEC4_SNAPSHOT); // ac-10: the snapshot of a range anchor is the selected text
    const start = SOURCE.indexOf("llm_call");
    const end = SOURCE.indexOf(" when an outbound"); // end of "...events"
    const comment = await addAnchoredComment(
      memexId,
      anchorSectionId,
      "Wic",
      "This whole phrase.",
      end,
      { type: "issue" },
      start, // anchorStartOffset → range
    );

    const content = await sectionContent(anchorSectionId);
    const s = content.indexOf(markerStartGlyph(comment.seq));
    const e = content.indexOf(markerEndGlyph(comment.seq));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(e).toBeGreaterThan(s);
    // The text between the sentinels is exactly the selected span.
    const between = content.slice(s + markerStartGlyph(comment.seq).length, e);
    expect(between).toBe("llm_call events");
    // The snapshot is the selected text, not the surrounding sentence.
    expect(comment.anchorSnippet).toBe("llm_call events");
  });

  it("captures the snapshot snippet (the sentence at the offset) at creation", async () => {
    tagAc(AC_DEC4_SNAPSHOT);
    const offset = SOURCE.indexOf("llm_call");
    const comment = await addAnchoredComment(
      memexId,
      anchorSectionId,
      "Wic",
      "Another anchored note.",
      offset,
    );

    expect(comment.anchorSnippet).toBe(
      "The proxy emits llm_call events when an outbound call is made.",
    );
    expect(isAnchored(comment)).toBe(true);
  });

  it("is atomic: a bad section id creates no comment and mutates no source", async () => {
    await expect(
      addAnchoredComment(memexId, "00000000-0000-0000-0000-000000000000", "Wic", "x", 0),
    ).rejects.toThrow();
  });
});

describe("orphan detection — marker edited out of the source", () => {
  let orphanSectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Orphan Doc", "Purpose");
    createdDocIds.push(doc.id);
    orphanSectionId = doc.sections[0].id;
    await updateSection(memexId, orphanSectionId, "Keep this sentence. Drop that one later.");
  });

  it("an anchored comment is not orphaned while its marker is present", async () => {
    tagAc(AC_DEC1_ANCHOR);
    const offset = "Keep this sentence.".length;
    const comment = await addAnchoredComment(
      memexId,
      orphanSectionId,
      "Wic",
      "anchored",
      offset,
    );
    const content = await sectionContent(orphanSectionId);
    expect(isCommentOrphaned(comment, content)).toBe(false);
  });

  it("becomes orphaned when an edit removes the marker, but the snapshot survives", async () => {
    tagAc(AC_DEC1_ANCHOR);
    const offset = "Keep this sentence.".length;
    const comment = await addAnchoredComment(
      memexId,
      orphanSectionId,
      "Wic",
      "will be orphaned",
      offset,
    );
    expect(comment.anchorSnippet).not.toBeNull();

    // An edit wipes the section content entirely — the marker is gone.
    await updateSection(memexId, orphanSectionId, "Completely rewritten, no markers at all.");
    const content = await sectionContent(orphanSectionId);

    expect(isCommentOrphaned(comment, content)).toBe(true);
    // The conversation is preserved as evidence: snapshot still readable.
    expect(comment.anchorSnippet).toBeTruthy();
  });

  it("a floating comment is never orphaned (it was never anchored)", async () => {
    const comment = await addComment(memexId, orphanSectionId, "Wic", "floating");
    expect(isCommentOrphaned(comment, "any content")).toBe(false);
  });
});

describe("deleteComment — own-comment ownership + marker cleanup", () => {
  let secId: string;
  let ownerId: string;
  let otherId: string;
  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Delete Doc", "Purpose");
    createdDocIds.push(doc.id);
    secId = doc.sections[0].id;
    await updateSection(memexId, secId, "Alpha sentence here. Beta sentence here.");
    ownerId = (await upsertUserByEmail("geo-owner@test.local")).id;
    otherId = (await upsertUserByEmail("geo-other@test.local")).id;
  });

  it("lets the author delete their own anchored comment and strips its marker", async () => {
    tagAc(AC_RESOLVE_DELETE);
    const c = await addAnchoredComment(memexId, secId, "Wic", "mine", "Alpha sentence here.".length, {
      authorUserId: ownerId,
    });
    expect(await sectionContent(secId)).toContain(markerEndGlyph(c.seq));

    await deleteComment(memexId, c.id, ownerId);

    // Comment row gone; marker stripped from the source.
    const gone = await db.query.docComments.findFirst({ where: eq(docComments.id, c.id) });
    expect(gone).toBeUndefined();
    expect(await sectionContent(secId)).not.toContain(markerEndGlyph(c.seq));
  });

  it("refuses to delete a comment authored by someone else", async () => {
    tagAc(AC_RESOLVE_DELETE);
    const c = await addComment(memexId, secId, "Wic", "not yours", { authorUserId: ownerId });
    await expect(deleteComment(memexId, c.id, otherId)).rejects.toThrow(ValidationError);
    await expect(deleteComment(memexId, c.id, null)).rejects.toThrow(ValidationError);
  });
});
