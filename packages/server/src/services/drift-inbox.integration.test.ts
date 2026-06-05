// Integration test for the t-10 Drift Inbox service.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createStandard, flagDrift, proposeStandardChange } from "./standards.js";
import { createDocDraft } from "./documents.js";
import { addComment, resolveComment } from "./comments.js";
import { listDriftInbox } from "./drift-inbox.js";
import { makeTestMemex } from "./test-helpers.js";

const SPEC_143 = "mindset-prod/memex-building-itself/specs/spec-143";

const createdDocIds: string[] = [];
let memexId: string;
let otherAccountId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("drift");
  otherAccountId = await makeTestMemex("drift2");
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

// Re-enabled after t-17 of doc-15: services/drift-inbox.ts now references
// `c.memex_id` (column renamed by migration 0038). Source-fix landed; unskipping.
describe("listDriftInbox", () => {
  it("returns open drift + plan_revision comments with parent doc/section context", async () => {
    const std = await createStandard(memexId, {
      title: "Inbox target",
      sections: [
        { sectionType: "do", content: "Always X." },
        { sectionType: "verify", content: "Check Y." },
      ],
    });
    createdDocIds.push(std.id);

    const driftComment = await flagDrift(
      memexId,
      std.sections[0].id,
      "Repo no longer does X.",
    );
    const proposal = await proposeStandardChange(
      memexId,
      std.sections[1].id,
      "Check Y AND Z.",
      "Z slipped through review.",
    );

    // Discussion-typed comment must NOT show up — inbox is drift+plan_revision only.
    await addComment(
      memexId,
      std.sections[0].id,
      "Author",
      "just a comment",
    );

    const page = await listDriftInbox(memexId);
    const ids = page.items.map((r) => r.commentId);
    expect(ids).toContain(driftComment.id);
    expect(ids).toContain(proposal.comment.id);
    // Discussion comment excluded.
    for (const r of page.items) {
      expect(["drift", "plan_revision"]).toContain(r.commentType);
    }

    const driftRow = page.items.find((r) => r.commentId === driftComment.id);
    expect(driftRow?.doc.id).toBe(std.id);
    expect(driftRow?.doc.handle).toBe(std.handle);
    expect(driftRow?.section?.sectionType).toBe("do");
    expect(driftRow?.source).toBe("agent");
    // spec-143 i-2: every row carries its per-doc c-N handle so items are
    // referenceable by handle in the UI and by the agent.
    expect(driftRow?.commentHandle).toMatch(/^c-\d+$/);
  });

  it("excludes resolved comments", async () => {
    const std = await createStandard(memexId, {
      title: "Resolved-out target",
      sections: [{ sectionType: "do", content: "Always X." }],
    });
    createdDocIds.push(std.id);
    const drift = await flagDrift(memexId, std.sections[0].id, "Drift to resolve");

    let page = await listDriftInbox(memexId);
    expect(page.items.find((r) => r.commentId === drift.id)).toBeDefined();

    await resolveComment(memexId, drift.id);

    page = await listDriftInbox(memexId);
    expect(page.items.find((r) => r.commentId === drift.id)).toBeUndefined();
  });

  it("does not leak rows across memexes", async () => {
    const std = await createStandard(otherAccountId, {
      title: "Other tenant",
      sections: [{ sectionType: "do", content: "Other rule." }],
    });
    createdDocIds.push(std.id);
    const drift = await flagDrift(otherAccountId, std.sections[0].id, "Other drift");

    const page = await listDriftInbox(memexId);
    expect(page.items.find((r) => r.commentId === drift.id)).toBeUndefined();
  });

  it("excludes drift on non-standard docs — drift is standards-only (b-63)", async () => {
    const m = await makeTestMemex("drift-std-only");
    // A non-standard doc (spec). Force a drift comment onto its section via the
    // generic addComment path, bypassing flagDrift's standard-only write guard.
    const spec = await createDocDraft(m, "Not a standard", "purpose", "spec");
    createdDocIds.push(spec.id);
    const forced = await addComment(
      m,
      spec.sections[0].id,
      "Author",
      "forced drift on a spec",
      { type: "drift" },
    );

    // A genuine standard drift for contrast.
    const std = await createStandard(m, {
      title: "Real standard",
      sections: [{ sectionType: "do", content: "Always X." }],
    });
    createdDocIds.push(std.id);
    const realDrift = await flagDrift(m, std.sections[0].id, "Repo no longer does X.");

    const page = await listDriftInbox(m);
    const ids = page.items.map((r) => r.commentId);
    expect(ids).toContain(realDrift.id);
    // The forced non-standard drift must NOT surface.
    expect(ids).not.toContain(forced.id);
    // Every row in the inbox is anchored to a Standard.
    for (const r of page.items) expect(r.doc.docType).toBe("standard");
  });

  it("?doc=std-N narrows the inbox to a single standard; unknown handle is empty", async () => {
    const m = await makeTestMemex("drift-doc-filter");
    const stdA = await createStandard(m, {
      title: "Standard A",
      sections: [{ sectionType: "do", content: "A rule." }],
    });
    const stdB = await createStandard(m, {
      title: "Standard B",
      sections: [{ sectionType: "do", content: "B rule." }],
    });
    createdDocIds.push(stdA.id, stdB.id);
    const driftA = await flagDrift(m, stdA.sections[0].id, "A drifted");
    const driftB = await flagDrift(m, stdB.sections[0].id, "B drifted");

    const filtered = await listDriftInbox(m, { docHandle: stdA.handle });
    const ids = filtered.items.map((r) => r.commentId);
    expect(ids).toContain(driftA.id);
    expect(ids).not.toContain(driftB.id);

    // Unknown handle → empty page, no error, no existence leak (std-7).
    const empty = await listDriftInbox(m, { docHandle: "std-999999" });
    expect(empty.items).toHaveLength(0);
  });

  it("paginates with cursor + limit", async () => {
    const paginAccount = await makeTestMemex("drift-pagin");
    const std = await createStandard(paginAccount, {
      title: "Pagination target",
      sections: [{ sectionType: "do", content: "Rule." }],
    });
    createdDocIds.push(std.id);

    // Seed 5 drift comments. Order is preserved by created_at + id tiebreaker, so we
    // can assert pagination is stable even when timestamps share a millisecond.
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await flagDrift(paginAccount, std.sections[0].id, `Drift #${i}`);
      created.push(c.id);
    }
    // Newest-first ordering — reverse of insertion order.
    const expectedOrder = [...created].reverse();

    const page1 = await listDriftInbox(paginAccount, { limit: 2 });
    expect(page1.items.map((r) => r.commentId)).toEqual(expectedOrder.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listDriftInbox(paginAccount, {
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((r) => r.commentId)).toEqual(expectedOrder.slice(2, 4));
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listDriftInbox(paginAccount, {
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items.map((r) => r.commentId)).toEqual(expectedOrder.slice(4));
    expect(page3.nextCursor).toBeNull();
  });

  it("clamps absurd limits to MAX_LIMIT", async () => {
    const page = await listDriftInbox(memexId, { limit: 99999 });
    // Just verify it doesn't throw and returns a page (smaller than the cap).
    expect(page.items.length).toBeLessThanOrEqual(200);
  });

  // spec-143 dec-2 (ac-9): the read layer normalizes every plan_revision to
  // applyable proposedContent — fenced proposals parse out the fence, UNFENCED
  // proposals fall back to the raw body (never null), and drift observations
  // stay null. This removes the UI fall-through-to-a-blob path at its source.
  it("normalizes proposedContent: fenced parses, unfenced falls back to the body, drift is null (spec-143 dec-2)", async () => {
    tagAc(`${SPEC_143}/acs/ac-9`);
    const m = await makeTestMemex("drift-normalize");

    const std = await createStandard(m, {
      title: "Normalize target",
      sections: [
        { sectionType: "do", content: "Always X." },
        { sectionType: "verify", content: "Check Y." },
      ],
    });
    createdDocIds.push(std.id);

    // A drift observation — proposedContent must be null.
    const drift = await flagDrift(m, std.sections[0].id, "Repo no longer does X.");

    // A canonical (fenced) proposal — proposedContent is the parsed fence body.
    const fenced = await proposeStandardChange(
      m,
      std.sections[1].id,
      "Check Y AND Z.",
      "Z slipped through review.",
    );

    // An UNFENCED plan_revision, forced through the generic comment path the way
    // the standards-only test above forces a non-standard drift. The read layer
    // must still yield applyable text (the raw body), not null/blob.
    const unfenced = await addComment(
      m,
      std.sections[0].id,
      "Author",
      "Please tighten the wording on this rule.",
      { type: "plan_revision" },
    );

    const page = await listDriftInbox(m);

    const driftRow = page.items.find((r) => r.commentId === drift.id);
    expect(driftRow?.commentType).toBe("drift");
    expect(driftRow?.proposedContent).toBeNull();

    const fencedRow = page.items.find((r) => r.commentId === fenced.comment.id);
    expect(fencedRow?.commentType).toBe("plan_revision");
    expect(fencedRow?.proposedContent).toBe("Check Y AND Z.");

    const unfencedRow = page.items.find((r) => r.commentId === unfenced.id);
    expect(unfencedRow?.commentType).toBe("plan_revision");
    // Never null — the fall-through-to-a-blob path is gone; raw body is applyable.
    expect(unfencedRow?.proposedContent).toBe(
      "Please tighten the wording on this rule.",
    );
  });

  // spec-143 dec-1 (ac-7, server half): with flag_drift restored, calling
  // flagDrift on a standard section produces a drift comment that surfaces in
  // listDriftInbox; calling it on a non-standard section is still rejected by
  // the existing loadOwnedStandard guard (re-exposure, not new write logic).
  it("flag_drift on a standard surfaces in the inbox; on a non-standard it is rejected by loadOwnedStandard (spec-143 dec-1)", async () => {
    tagAc(`${SPEC_143}/acs/ac-7`);
    const m = await makeTestMemex("drift-ac7");

    // Standard section → drift comment surfaces in the inbox.
    const std = await createStandard(m, {
      title: "AC-7 standard",
      sections: [{ sectionType: "do", content: "Always X." }],
    });
    createdDocIds.push(std.id);
    const drift = await flagDrift(m, std.sections[0].id, "Repo no longer does X.");
    expect(drift.commentType).toBe("drift");

    const page = await listDriftInbox(m);
    const row = page.items.find((r) => r.commentId === drift.id);
    expect(row).toBeDefined();
    expect(row?.doc.docType).toBe("standard");

    // Non-standard section → loadOwnedStandard rejects (standards-only invariant).
    const spec = await createDocDraft(m, "Not a standard", "purpose", "spec");
    createdDocIds.push(spec.id);
    await expect(
      flagDrift(m, spec.sections[0].id, "drift on a spec"),
    ).rejects.toThrow(/not a standard/i);
  });
});
