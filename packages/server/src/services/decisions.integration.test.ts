import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  createDecision,
  listDecisions,
  getDecision,
  getDecisionByHandle,
  getDecisionByQualifiedHandle,
  AmbiguousDecisionHandleError,
  resolveDecision,
  reopenDecision,
  updateDecisionFields,
  proposeDecision,
  approveDecision,
  rejectDecision,
  setDecisionOptions,
  deleteDecision,
  restoreDecision,
  type DecisionOption,
} from "./decisions.js";
import { tagAc } from "@memex-ai-ac/vitest";
import { createStandard } from "./standards.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus } from "./bus.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});


let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("createDecision", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Decision Test Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("creates a decision with open status", async () => {
    const dec = await createDecision(memexId, docId, "Use REST or gRPC?");
    expect(dec.title).toBe("Use REST or gRPC?");
    expect(dec.status).toBe("open");
    expect(dec.docId).toBe(docId);
    expect(dec.resolution).toBeNull();
    expect(dec.resolvedAt).toBeNull();
  });

  it("creates a decision with optional context", async () => {
    const dec = await createDecision(memexId, docId, "Which DB?", "We need ACID compliance");
    expect(dec.context).toBe("We need ACID compliance");
  });

  it("assigns sequential seq numbers within a document", async () => {
    const doc2 = await createDocDraft(memexId, "Seq Test Doc", "Purpose");
    createdDocIds.push(doc2.id);

    const dec1 = await createDecision(memexId, doc2.id, "First");
    const dec2 = await createDecision(memexId, doc2.id, "Second");

    expect(dec2.seq).toBe(dec1.seq + 1);
  });
});

describe("listDecisions", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "List Decisions Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
    await createDecision(memexId, docId, "Dec A");
    await createDecision(memexId, docId, "Dec B");
  });

  it("returns decisions ordered by seq", async () => {
    const list = await listDecisions(memexId, docId);
    expect(list).toHaveLength(2);
    expect(list[0].title).toBe("Dec A");
    expect(list[1].title).toBe("Dec B");
    expect(list[0].seq).toBeLessThan(list[1].seq);
  });

  it("returns empty array for doc with no decisions", async () => {
    const doc = await createDocDraft(memexId, "Empty Dec Doc", "Purpose");
    createdDocIds.push(doc.id);
    const list = await listDecisions(memexId, doc.id);
    expect(list).toEqual([]);
  });
});

describe("getDecision", () => {
  let docId: string;
  let decision: Awaited<ReturnType<typeof createDecision>>;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Get Decision Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
    decision = await createDecision(memexId, docId, "Lookup Test");
  });

  it("retrieves by UUID", async () => {
    const found = await getDecision(memexId, decision.id);
    expect(found.id).toBe(decision.id);
    expect(found.title).toBe("Lookup Test");
  });

  it("retrieves by D-N handle with docId", async () => {
    const found = await getDecision(memexId, `D-${decision.seq}`, docId);
    expect(found.id).toBe(decision.id);
  });

  it("throws NotFoundError for non-existent UUID", async () => {
    await expect(
      getDecision(memexId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ValidationError for invalid format without docId", async () => {
    await expect(getDecision(memexId, "D-1")).rejects.toThrow(ValidationError);
  });
});

// t-18: account-wide handle resolution for standard `[per dec-N]` references.
// The lookup must (a) succeed inside the owning account, (b) return the row's
// parent docId so the React UI can build the navigation target, and (c) refuse
// to leak rows from another account that happen to share the same handle.
//
// We intentionally use *fresh* test memexes here — the `memexId` shared by
// the rest of this file accumulates many decisions across describe blocks, and
// a per-account handle search would non-deterministically pick whichever row
// the database returns first. Fresh memexes keep the assertions deterministic.
describe("getDecisionByHandle (t-18)", () => {
  let isolatedAccountId: string;
  let docId: string;
  let decision: Awaited<ReturnType<typeof createDecision>>;
  let otherAccountId: string;

  beforeAll(async () => {
    isolatedAccountId = await makeTestMemex();
    const doc = await createDocDraft(isolatedAccountId, "Handle Lookup Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
    decision = await createDecision(isolatedAccountId, docId, "Lookup By Handle");

    // Bring up a separate account so we can prove the lookup is account-
    // scoped (handles repeat across memexes).
    otherAccountId = await makeTestMemex();
    const otherDoc = await createDocDraft(otherAccountId, "Other Doc", "Purpose");
    createdDocIds.push(otherDoc.id);
    await createDecision(otherAccountId, otherDoc.id, "Other Account Decision");
  });

  it("resolves a dec-N handle to its decision (with docId for nav)", async () => {
    const found = await getDecisionByHandle(isolatedAccountId, `dec-${decision.seq}`);
    expect(found.id).toBe(decision.id);
    expect(found.docId).toBe(docId);
    expect(found.title).toBe("Lookup By Handle");
  });

  it("throws NotFoundError when no decision exists with that handle in the account", async () => {
    await expect(
      getDecisionByHandle(isolatedAccountId, "dec-9999"),
    ).rejects.toThrow(NotFoundError);
  });

  it("does NOT leak a sibling account's row when handles collide", async () => {
    // Both memexes have a dec-1 (the first decision in their first doc).
    // The owning-account lookup returns *our* row; asking the other account
    // returns *theirs*. The two ids must be distinct.
    const ours = await getDecisionByHandle(isolatedAccountId, `dec-${decision.seq}`);
    const theirs = await getDecisionByHandle(otherAccountId, "dec-1");
    expect(ours.id).toBe(decision.id);
    expect(theirs.id).not.toBe(decision.id);
  });

  it("throws ValidationError on a malformed handle", async () => {
    await expect(
      getDecisionByHandle(isolatedAccountId, "not-a-handle"),
    ).rejects.toThrow(ValidationError);
  });
});

// t-20 W-A — qualified canonical handles `doc-N:dec-M` and bare-with-collision
// disambiguation. The previous getDecisionByHandle silently returned the first
// match when the bare handle resolved to multiple rows; that's the bug t-18
// surfaced. Now the bare path throws AmbiguousDecisionHandleError carrying the
// candidate qualified handles.
describe("getDecisionByHandle / getDecisionByQualifiedHandle (t-20 W-A)", () => {
  let acc: string;
  let docA: Awaited<ReturnType<typeof createDocDraft>>;
  let docB: Awaited<ReturnType<typeof createDocDraft>>;
  let decA1: Awaited<ReturnType<typeof createDecision>>;
  let decB1: Awaited<ReturnType<typeof createDecision>>;
  let lonelyDoc: Awaited<ReturnType<typeof createDocDraft>>;
  let lonelyDec: Awaited<ReturnType<typeof createDecision>>;

  beforeAll(async () => {
    acc = await makeTestMemex();
    docA = await createDocDraft(acc, "Spec A", "Purpose");
    docB = await createDocDraft(acc, "Spec B", "Purpose");
    lonelyDoc = await createDocDraft(acc, "Spec C (no collision)", "Purpose");
    createdDocIds.push(docA.id, docB.id, lonelyDoc.id);

    // Both docs get a dec-1 — same bare handle, different parents. This is
    // the per-doc seq behaviour that motivates the qualified form.
    decA1 = await createDecision(acc, docA.id, "Choice in A");
    decB1 = await createDecision(acc, docB.id, "Choice in B");

    // Single-match bare handle for the no-collision path. Two decisions on
    // lonelyDoc so the second one (seq=2) is uncontested across the account
    // (docA + docB only have a dec-1 each — neither has a dec-2). dec-2 is
    // therefore an unambiguous bare handle.
    await createDecision(acc, lonelyDoc.id, "Solo first");
    lonelyDec = await createDecision(acc, lonelyDoc.id, "Solo second");
  });

  it("resolves the qualified `doc-N:dec-M` form unambiguously", async () => {
    const fromA = await getDecisionByQualifiedHandle(acc, docA.handle, "D-1");
    const fromB = await getDecisionByQualifiedHandle(acc, docB.handle, "D-1");
    expect(fromA.id).toBe(decA1.id);
    expect(fromB.id).toBe(decB1.id);
    expect(fromA.id).not.toBe(fromB.id);
  });

  it("getDecisionByHandle accepts the qualified form too", async () => {
    const fromA = await getDecisionByHandle(acc, `${docA.handle}:D-1`);
    expect(fromA.id).toBe(decA1.id);
  });

  it("getDecisionByHandle returns the row when bare matches exactly one decision", async () => {
    // dec-2 only exists on lonelyDoc — docA / docB have dec-1 only.
    expect(lonelyDec.seq).toBe(2);
    const found = await getDecisionByHandle(acc, `dec-${lonelyDec.seq}`);
    expect(found.id).toBe(lonelyDec.id);
  });

  it("getDecisionByHandle throws AmbiguousDecisionHandleError on bare-with-multiple-matches (no silent first-match)", async () => {
    let caught: AmbiguousDecisionHandleError | null = null;
    try {
      await getDecisionByHandle(acc, "dec-1");
    } catch (err) {
      if (err instanceof AmbiguousDecisionHandleError) caught = err;
    }
    expect(caught).not.toBeNull();
    // Three docs in this account had a decision created (docA, docB,
    // lonelyDoc) — and per-doc seq starts at 1 — so all three appear as
    // candidates for bare `dec-1`. Order is alphabetical for determinism.
    expect(caught!.candidates).toEqual(
      [
        `${docA.handle}:D-1`,
        `${docB.handle}:D-1`,
        `${lonelyDoc.handle}:D-1`,
      ].sort(),
    );
    expect(caught!.code).toBe("AMBIGUOUS_DECISION_HANDLE");
  });

  it("getDecisionByQualifiedHandle 404s when the parent doc isn't in the account", async () => {
    await expect(
      getDecisionByQualifiedHandle(acc, "doc-9999", "D-1"),
    ).rejects.toThrow(NotFoundError);
  });

  it("getDecisionByHandle ValidationError on neither bare nor qualified shape", async () => {
    await expect(getDecisionByHandle(acc, "decision-1")).rejects.toThrow(
      ValidationError,
    );
  });
});

// t-7 — `mis-N:(D|dec)-M` is the canonical Spec decision cite emitted in
// standards content. Post doc-26 Briefs share the `doc-N` handle namespace
// (see migration 0048) so the parser rewrites `mis-N` → `doc-N` for lookup; the
// `mis-` cite syntax stays per dec-2 because that's what already-stored
// standards markdown uses. The decision portion accepts both `D-M` (canonical)
// and `dec-M` (legacy fallback for un-migrated content) thanks to the dual
// regex in parseDecisionHandle.
describe("getDecisionByHandle mis-N:dec-M (t-7)", () => {
  let acc: string;
  let spec: Awaited<ReturnType<typeof createDocDraft>>;
  let standardDoc: Awaited<ReturnType<typeof createStandard>>;
  let specDecision: Awaited<ReturnType<typeof createDecision>>;
  let standardDecision: Awaited<ReturnType<typeof createDecision>>;

  // Helper: peel the numeric suffix off any prefixed handle (`doc-3` → `3`,
  // `doc-12` → `12`, `std-4` → `4`). Centralises the regex.
  const seqOf = (h: string): string => h.replace(/^[A-Za-z]+-/, "");

  beforeAll(async () => {
    acc = await makeTestMemex();
    // Spec parent — explicit docType so the `mis-` cite resolves through
    // the requireBriefParent gate. Post b-105 the handle is `spec-N`.
    spec = await createDocDraft(acc, "Spec for cites", "Purpose", "spec");
    createdDocIds.push(spec.id);
    specDecision = await createDecision(acc, spec.id, "Cited from standard");

    // Standard parent (std-N namespace). Used to verify that `std-N:D-M`
    // legacy-qualified cites resolve regardless of docType.
    standardDoc = await createStandard(acc, {
      title: "Standard with a decision attached",
      sections: [{ sectionType: "overview", content: "Rules go here." }],
    });
    createdDocIds.push(standardDoc.id);
    standardDecision = await createDecision(
      acc,
      standardDoc.id,
      "Decision attached to a standard",
    );
  });

  it("resolves `mis-N:D-M` when the parent is a Spec", async () => {
    const found = await getDecisionByHandle(
      acc,
      `mis-${seqOf(spec.handle)}:D-${specDecision.seq}`,
    );
    expect(found.id).toBe(specDecision.id);
    expect(found.docId).toBe(spec.id);
  });

  it("accepts the legacy lowercase `mis-N:dec-M` form (un-migrated standard content)", async () => {
    // Standards content stored before the rename still emits `:dec-M`. The
    // parser tolerates that legacy form so existing markdown keeps resolving.
    const found = await getDecisionByHandle(
      acc,
      `mis-${seqOf(spec.handle)}:dec-${specDecision.seq}`,
    );
    expect(found.id).toBe(specDecision.id);
  });

  it("returns NotFoundError when the underlying spec doesn't exist", async () => {
    // mis-9999 rewrites to doc-9999 which has no row in the documents table.
    await expect(
      getDecisionByHandle(acc, "mis-9999:D-1"),
    ).rejects.toThrow(NotFoundError);
  });

  it("legacy `doc-N:D-M` continues to resolve regardless of parent docType", async () => {
    // Generic non-Spec parent in the `doc-N` namespace — the resolver
    // accepts the qualified form for any docType when the `mis-` parentKind
    // gate isn't engaged.
    const generic = await createDocDraft(
      acc,
      "Generic doc with a decision",
      "Purpose",
      "document",
    );
    createdDocIds.push(generic.id);
    const dec = await createDecision(acc, generic.id, "Decision on a generic doc");
    const handle = `${generic.handle}:D-${dec.seq}`;
    const found = await getDecisionByHandle(acc, handle);
    expect(found.id).toBe(dec.id);
  });

  it("`std-N:D-M` resolves cleanly to a Standard's decision", async () => {
    // Standards live in their own `std-N` handle namespace post-doc-8 dec-7.
    // The qualified parser accepts `doc-` and `std-` prefixes since they
    // share the documents.handle column.
    const handle = `${standardDoc.handle}:D-${standardDecision.seq}`;
    const found = await getDecisionByHandle(acc, handle);
    expect(found.id).toBe(standardDecision.id);
  });

  it("rejects malformed `mis-` shape with ValidationError", async () => {
    // Missing :D-M suffix — bare `mis-1` is not a recognised handle form.
    await expect(getDecisionByHandle(acc, "mis-1")).rejects.toThrow(
      ValidationError,
    );
  });
});

// t-20 W-C — decisions.source persistence across the propose → approve → resolve
// flow. The schema column is NOT NULL DEFAULT 'human'; new candidate flow
// defaults to 'agent' (matching the per-turn extraction caller). Direct
// createDecision defaults to 'human'. Status transitions don't touch source.
describe("decisions.source persistence (t-20 W-C)", () => {
  let acc: string;
  let docId: string;
  beforeAll(async () => {
    acc = await makeTestMemex();
    const doc = await createDocDraft(acc, "Source Test Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("createDecision defaults source to 'human'", async () => {
    const dec = await createDecision(acc, docId, "Direct human decision");
    expect(dec.source).toBe("human");
  });

  it("createDecision can be called with source='agent' explicitly", async () => {
    const dec = await createDecision(acc, docId, "Agent direct", undefined, "agent");
    expect(dec.source).toBe("agent");
  });

  it("proposeDecision defaults source to 'agent' and persists across approve→resolve", async () => {
    const candidate = await proposeDecision(acc, docId, {
      title: "Agent-proposed candidate",
      options: [
        { label: "A", trade_offs: "x" },
        { label: "B", trade_offs: "y" },
      ],
    });
    expect(candidate.source).toBe("agent");

    const approved = await approveDecision(acc, candidate.id);
    expect(approved.source).toBe("agent");

    const resolved = await resolveDecision(acc, candidate.id, "Picked A", 0);
    expect(resolved.source).toBe("agent");
  });

  it("proposeDecision honours an explicit source override", async () => {
    const candidate = await proposeDecision(acc, docId, {
      title: "Human-driven candidate",
      source: "human",
    });
    expect(candidate.source).toBe("human");
  });

  it("backfill: every existing decision row surfaces source IN ('human','agent')", async () => {
    // Sweep across the whole table — pre-migration rows must satisfy the
    // NOT NULL DEFAULT 'human' from 0027_v2_deferral_fixes.
    const rows = await db.select({ source: decisions.source }).from(decisions);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(["human", "agent"]).toContain(r.source);
    }
  });
});

describe("resolveDecision", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Resolve Decision Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("transitions to resolved with resolution text", async () => {
    const dec = await createDecision(memexId, docId, "To resolve");
    const resolved = await resolveDecision(memexId, dec.id, "Go with PostgreSQL");

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("Go with PostgreSQL");
    expect(resolved.resolvedAt).toBeTruthy();
  });

  it("throws ValidationError when already resolved", async () => {
    const dec = await createDecision(memexId, docId, "Double resolve");
    await resolveDecision(memexId, dec.id, "First resolution");

    await expect(
      resolveDecision(memexId, dec.id, "Second resolution")
    ).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError for non-existent id", async () => {
    await expect(
      resolveDecision(memexId, "00000000-0000-0000-0000-000000000000", "Resolution")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("reopenDecision", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Reopen Decision Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("transitions resolved back to open", async () => {
    const dec = await createDecision(memexId, docId, "To reopen");
    await resolveDecision(memexId, dec.id, "Initial choice");

    const reopened = await reopenDecision(memexId, dec.id);
    expect(reopened.status).toBe("open");
    expect(reopened.resolvedAt).toBeNull();
  });

  it("preserves resolution as 'Proposed:' prefix", async () => {
    const dec = await createDecision(memexId, docId, "Preserve resolution");
    await resolveDecision(memexId, dec.id, "Use Redis");

    const reopened = await reopenDecision(memexId, dec.id);
    expect(reopened.resolution).toBe("Proposed: Use Redis");
  });

  it("throws ValidationError when already open", async () => {
    const dec = await createDecision(memexId, docId, "Already open");
    await expect(reopenDecision(memexId, dec.id)).rejects.toThrow(ValidationError);
  });
});

describe("updateDecisionFields (edit-in-place)", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Edit-in-place Decision Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("edits resolution prose on a resolved decision without changing status", async () => {
    const dec = await createDecision(memexId, docId, "Polish me");
    const resolved = await resolveDecision(memexId, dec.id, "Initial wording");
    const resolvedAt = resolved.resolvedAt;

    const updated = await updateDecisionFields(memexId, dec.id, {
      resolution: "Tightened wording — same decision, clearer prose",
    });

    expect(updated.status).toBe("resolved");
    expect(updated.resolution).toBe(
      "Tightened wording — same decision, clearer prose",
    );
    expect(updated.resolvedAt).toEqual(resolvedAt);
  });

  it("edits title and context on a resolved decision", async () => {
    const dec = await createDecision(memexId, docId, "Original title", "Original context");
    await resolveDecision(memexId, dec.id, "Pick A");

    const updated = await updateDecisionFields(memexId, dec.id, {
      title: "Sharper title",
      context: "Expanded context after seeing usage",
    });

    expect(updated.title).toBe("Sharper title");
    expect(updated.context).toBe("Expanded context after seeing usage");
    expect(updated.status).toBe("resolved");
  });

  it("rejects clearing resolution to empty on a resolved decision", async () => {
    const dec = await createDecision(memexId, docId, "Keep resolution");
    await resolveDecision(memexId, dec.id, "Some choice");

    await expect(
      updateDecisionFields(memexId, dec.id, { resolution: "   " }),
    ).rejects.toThrow(ValidationError);
  });

  it("updates chosenOptionIndex when in-range; rejects out-of-range", async () => {
    const options: DecisionOption[] = [
      { label: "A", trade_offs: "fast" },
      { label: "B", trade_offs: "slow" },
    ];
    const dec = await createDecision(memexId, docId, "Multi-option");
    await setDecisionOptions(memexId, dec.id, options);
    await resolveDecision(memexId, dec.id, "Going with A", 0);

    const flipped = await updateDecisionFields(memexId, dec.id, { chosenOptionIndex: 1 });
    expect(flipped.chosenOptionIndex).toBe(1);

    await expect(
      updateDecisionFields(memexId, dec.id, { chosenOptionIndex: 5 }),
    ).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError for unknown decision id", async () => {
    await expect(
      updateDecisionFields(memexId, "00000000-0000-0000-0000-000000000000", {
        resolution: "irrelevant",
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ── Multi-option / candidate workflow (t-5) ─────────────────
// Per dec-4 / dec-21 / dec-22: agent extraction emits a candidate, human approves or
// rejects, then the regular resolve flow runs. Status transitions are strict —
// candidate→{open|rejected}, open→resolved, resolved→open. Anything else throws.

describe("proposeDecision / candidate workflow", () => {
  let docId: string;
  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Candidate Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("creates a candidate decision with options", async () => {
    const options: DecisionOption[] = [
      { label: "Postgres", trade_offs: "ACID, mature, requires self-hosting" },
      { label: "DynamoDB", trade_offs: "Managed, eventual consistency" },
    ];
    const dec = await proposeDecision(memexId, docId, {
      title: "Datastore?",
      context: "Need persistence for orders",
      options,
    });

    expect(dec.status).toBe("candidate");
    expect(dec.title).toBe("Datastore?");
    expect(dec.context).toBe("Need persistence for orders");
    expect(dec.options).toEqual(options);
    expect(dec.chosenOptionIndex).toBeNull();
  });

  it("creates a candidate without options when none provided", async () => {
    const dec = await proposeDecision(memexId, docId, { title: "No options yet" });
    expect(dec.status).toBe("candidate");
    expect(dec.options).toBeNull();
  });

  it("rejects malformed options (missing trade_offs)", async () => {
    await expect(
      proposeDecision(memexId, docId, {
        title: "Bad options",
        // @ts-expect-error – intentional malformed shape for the validator
        options: [{ label: "x" }],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects empty title", async () => {
    await expect(
      proposeDecision(memexId, docId, { title: "   " }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("approveDecision / rejectDecision", () => {
  let docId: string;
  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Approve/Reject Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("candidate → open via approveDecision", async () => {
    const dec = await proposeDecision(memexId, docId, { title: "Approve me" });
    const approved = await approveDecision(memexId, dec.id);
    expect(approved.status).toBe("open");
  });

  it("approveDecision throws on non-candidate", async () => {
    const open = await createDecision(memexId, docId, "Already open");
    await expect(approveDecision(memexId, open.id)).rejects.toThrow(ValidationError);

    const candidate = await proposeDecision(memexId, docId, { title: "Twice approved" });
    await approveDecision(memexId, candidate.id);
    await expect(approveDecision(memexId, candidate.id)).rejects.toThrow(ValidationError);
  });

  it("candidate → rejected via rejectDecision (preserves reason)", async () => {
    const dec = await proposeDecision(memexId, docId, { title: "Reject me" });
    const rejected = await rejectDecision(memexId, dec.id, "Not relevant to scope");
    expect(rejected.status).toBe("rejected");
    expect(rejected.resolution).toBe("Not relevant to scope");
    expect(rejected.resolvedAt).toBeTruthy();
  });

  it("rejectDecision throws on non-candidate", async () => {
    const open = await createDecision(memexId, docId, "Open dec");
    await expect(rejectDecision(memexId, open.id, "Nope")).rejects.toThrow(ValidationError);
  });

  it("rejectDecision throws on empty reason", async () => {
    const dec = await proposeDecision(memexId, docId, { title: "Need a reason" });
    await expect(rejectDecision(memexId, dec.id, "  ")).rejects.toThrow(ValidationError);
  });
});

describe("setDecisionOptions", () => {
  let docId: string;
  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "SetOptions Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("replaces options on an open decision", async () => {
    const dec = await createDecision(memexId, docId, "Pick a queue");
    const options: DecisionOption[] = [
      { label: "RabbitMQ", trade_offs: "Mature; ops overhead" },
      { label: "SQS", trade_offs: "Managed; AWS-only" },
    ];
    const updated = await setDecisionOptions(memexId, dec.id, options);
    expect(updated.options).toEqual(options);
  });

  it("works on a candidate decision", async () => {
    const dec = await proposeDecision(memexId, docId, { title: "Late options" });
    const updated = await setDecisionOptions(memexId, dec.id, [
      { label: "A", trade_offs: "fast" },
      { label: "B", trade_offs: "slow" },
    ]);
    expect((updated.options as DecisionOption[]).map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("throws when the decision is resolved or rejected", async () => {
    const open = await createDecision(memexId, docId, "Resolve first");
    await resolveDecision(memexId, open.id, "done");
    await expect(
      setDecisionOptions(memexId, open.id, [{ label: "X", trade_offs: "y" }]),
    ).rejects.toThrow(ValidationError);

    const cand = await proposeDecision(memexId, docId, { title: "Reject first" });
    await rejectDecision(memexId, cand.id, "no");
    await expect(
      setDecisionOptions(memexId, cand.id, [{ label: "X", trade_offs: "y" }]),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects malformed shapes", async () => {
    const dec = await createDecision(memexId, docId, "Bad shape");
    await expect(
      // @ts-expect-error – intentional malformed shape for the validator
      setDecisionOptions(memexId, dec.id, "not an array"),
    ).rejects.toThrow(ValidationError);
  });
});

describe("resolveDecision with chosenOptionIndex", () => {
  let docId: string;
  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Chosen Index Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("persists chosenOptionIndex when within bounds", async () => {
    // spec-209 ac-4: the with-options path is unchanged — an in-bounds index records.
    tagAc("mindset-prod/memex-building-itself/specs/spec-209/acs/ac-4");
    tagAc("mindset-prod/memex-building-itself/specs/spec-209/acs/ac-2"); // scope
    const dec = await createDecision(memexId, docId, "Pick");
    await setDecisionOptions(memexId, dec.id, [
      { label: "A", trade_offs: "x" },
      { label: "B", trade_offs: "y" },
    ]);
    const resolved = await resolveDecision(memexId, dec.id, "Going with B", 1);
    expect(resolved.status).toBe("resolved");
    expect(resolved.chosenOptionIndex).toBe(1);
  });

  it("throws when chosenOptionIndex is out of bounds", async () => {
    // spec-209 ac-4: the with-options path is unchanged — out-of-bounds still errors.
    tagAc("mindset-prod/memex-building-itself/specs/spec-209/acs/ac-4");
    tagAc("mindset-prod/memex-building-itself/specs/spec-209/acs/ac-2"); // scope
    const dec = await createDecision(memexId, docId, "Pick OOB");
    await setDecisionOptions(memexId, dec.id, [{ label: "Solo", trade_offs: "only" }]);
    await expect(
      resolveDecision(memexId, dec.id, "should fail", 5),
    ).rejects.toThrow(ValidationError);
  });

  it("resolves on the prose when a chosenOptionIndex is supplied but no options exist (spec-209 dec-1)", async () => {
    // Pre-spec-209 this threw "chosenOptionIndex requires options to be set" —
    // the dominant resolve_decision failure (88% of its errors on prod). Now the
    // meaningless index is dropped and the decision resolves on the prose.
    tagAc("mindset-prod/memex-building-itself/specs/spec-209/acs/ac-3");
    tagAc("mindset-prod/memex-building-itself/specs/spec-209/acs/ac-1"); // scope
    const dec = await createDecision(memexId, docId, "No options, index supplied");
    const resolved = await resolveDecision(memexId, dec.id, "resolved on prose", 0);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("resolved on prose");
    expect(resolved.chosenOptionIndex).toBeNull();
  });

  it("works without chosenOptionIndex (legacy callers)", async () => {
    const dec = await createDecision(memexId, docId, "No-index resolve");
    const resolved = await resolveDecision(memexId, dec.id, "narrative only");
    expect(resolved.status).toBe("resolved");
    expect(resolved.chosenOptionIndex).toBeNull();
  });
});

describe("strict status transitions", () => {
  let docId: string;
  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Transition Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("resolveDecision throws on candidate", async () => {
    const cand = await proposeDecision(memexId, docId, { title: "Cand resolve" });
    await expect(resolveDecision(memexId, cand.id, "x")).rejects.toThrow(ValidationError);
  });

  it("resolveDecision throws on rejected", async () => {
    const cand = await proposeDecision(memexId, docId, { title: "Rejected resolve" });
    await rejectDecision(memexId, cand.id, "no");
    await expect(resolveDecision(memexId, cand.id, "x")).rejects.toThrow(ValidationError);
  });

  it("reopenDecision throws on candidate / rejected", async () => {
    const cand = await proposeDecision(memexId, docId, { title: "Cand reopen" });
    await expect(reopenDecision(memexId, cand.id)).rejects.toThrow(ValidationError);

    const cand2 = await proposeDecision(memexId, docId, { title: "Reject reopen" });
    await rejectDecision(memexId, cand2.id, "no");
    await expect(reopenDecision(memexId, cand2.id)).rejects.toThrow(ValidationError);
  });

  it("reopen clears chosenOptionIndex", async () => {
    const dec = await createDecision(memexId, docId, "Reopen clears");
    await setDecisionOptions(memexId, dec.id, [
      { label: "A", trade_offs: "x" },
      { label: "B", trade_offs: "y" },
    ]);
    await resolveDecision(memexId, dec.id, "Going A", 0);
    const reopened = await reopenDecision(memexId, dec.id);
    expect(reopened.chosenOptionIndex).toBeNull();
  });

  it("emits decision/updated on every transition", async () => {
    const dec = await proposeDecision(memexId, docId, { title: "Emit chain" });
    const seen: { entity: string; action: string }[] = [];
    const unsubscribe = bus.subscribe({ docId }, (e) =>
      seen.push({ entity: e.entity, action: e.action }),
    );
    try {
      await approveDecision(memexId, dec.id);
      await setDecisionOptions(memexId, dec.id, [
        { label: "A", trade_offs: "x" },
        { label: "B", trade_offs: "y" },
      ]);
      await resolveDecision(memexId, dec.id, "going A", 0);
      await reopenDecision(memexId, dec.id);

      const updates = seen.filter((s) => s.entity === "decision" && s.action === "updated");
      expect(updates.length).toBeGreaterThanOrEqual(4);
    } finally {
      unsubscribe();
    }
  });
});

describe("listDecisions / getDecision surface options + chosenOptionIndex", () => {
  it("returns options + chosenOptionIndex on list and get", async () => {
    const doc = await createDocDraft(memexId, "Surface Doc", "Purpose");
    createdDocIds.push(doc.id);
    const dec = await createDecision(memexId, doc.id, "Surface me");
    await setDecisionOptions(memexId, dec.id, [
      { label: "A", trade_offs: "x" },
      { label: "B", trade_offs: "y" },
    ]);
    await resolveDecision(memexId, dec.id, "A wins", 0);

    const list = await listDecisions(memexId, doc.id);
    expect(list[0].options).toEqual([
      { label: "A", trade_offs: "x" },
      { label: "B", trade_offs: "y" },
    ]);
    expect(list[0].chosenOptionIndex).toBe(0);

    const fetched = await getDecision(memexId, dec.id);
    expect(fetched.chosenOptionIndex).toBe(0);
  });
});

// b-97 ac-3: delete_decision + restore round-trip behaviour against the real
// schema. The DB enforces the `status` check constraint; these tests verify
// the soft-delete pivot lands rows in the new `deleted` status, that the
// previous_status capture is lossless, and that listDecisions hides deleted
// rows by default but returns them with the explicit includeDeleted flag.
describe("deleteDecision / restoreDecision (b-97)", () => {
  let docId: string;
  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "B-97 Delete/Restore Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("soft-deletes an open decision and captures previous_status", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const dec = await createDecision(memexId, docId, "Will be deleted from open");
    const deleted = await deleteDecision(memexId, dec.id);
    expect(deleted.status).toBe("deleted");
    expect(deleted.previousStatus).toBe("open");
    // Resolution and options stay intact — restore must be lossless.
    expect(deleted.title).toBe("Will be deleted from open");
  });

  it("soft-deletes a resolved decision and preserves resolution + options for restore", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const dec = await createDecision(memexId, docId, "Will be deleted from resolved");
    await setDecisionOptions(memexId, dec.id, [
      { label: "X", trade_offs: "fast" },
      { label: "Y", trade_offs: "cheap" },
    ]);
    await resolveDecision(memexId, dec.id, "X for speed.", 0);

    const deleted = await deleteDecision(memexId, dec.id);
    expect(deleted.status).toBe("deleted");
    expect(deleted.previousStatus).toBe("resolved");
    expect(deleted.resolution).toBe("X for speed.");
    expect(deleted.chosenOptionIndex).toBe(0);
    expect(deleted.options).toEqual([
      { label: "X", trade_offs: "fast" },
      { label: "Y", trade_offs: "cheap" },
    ]);
  });

  it("soft-deletes a candidate decision (no resolution yet) and captures previous_status='candidate'", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const dec = await proposeDecision(memexId, docId, {
      title: "Candidate to delete",
      options: [{ label: "A", trade_offs: "a" }],
    });
    const deleted = await deleteDecision(memexId, dec.id);
    expect(deleted.status).toBe("deleted");
    expect(deleted.previousStatus).toBe("candidate");
  });

  it("soft-deletes a rejected decision and captures previous_status='rejected'", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const dec = await proposeDecision(memexId, docId, {
      title: "Rejected to delete",
    });
    await rejectDecision(memexId, dec.id, "wrong question");
    const deleted = await deleteDecision(memexId, dec.id);
    expect(deleted.status).toBe("deleted");
    expect(deleted.previousStatus).toBe("rejected");
  });

  it("refuses to double-delete an already-deleted decision", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const dec = await createDecision(memexId, docId, "Delete me twice");
    await deleteDecision(memexId, dec.id);
    await expect(deleteDecision(memexId, dec.id)).rejects.toThrow(ValidationError);
  });

  it("listDecisions hides deleted rows by default", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const doc = await createDocDraft(memexId, "List filter doc", "Purpose");
    createdDocIds.push(doc.id);

    const keep = await createDecision(memexId, doc.id, "Keep me");
    const drop = await createDecision(memexId, doc.id, "Drop me");
    await deleteDecision(memexId, drop.id);

    const visible = await listDecisions(memexId, doc.id);
    const visibleIds = visible.map((d) => d.id);
    expect(visibleIds).toContain(keep.id);
    expect(visibleIds).not.toContain(drop.id);
  });

  it("listDecisions returns deleted rows when includeDeleted is set", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const doc = await createDocDraft(memexId, "List include-deleted doc", "Purpose");
    createdDocIds.push(doc.id);

    const a = await createDecision(memexId, doc.id, "Stay live");
    const b = await createDecision(memexId, doc.id, "Soft-deleted");
    await deleteDecision(memexId, b.id);

    const all = await listDecisions(memexId, doc.id, { includeDeleted: true });
    const ids = all.map((d) => d.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("restores a deleted decision to a target status and clears previous_status", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const dec = await createDecision(memexId, docId, "Round-trip me");
    const deleted = await deleteDecision(memexId, dec.id);
    expect(deleted.previousStatus).toBe("open");

    const restored = await restoreDecision(memexId, dec.id, "open");
    expect(restored.status).toBe("open");
    expect(restored.previousStatus).toBeNull();
  });

  it("restore is lossless: resolution + options + chosenOptionIndex survive a delete-restore round trip", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const dec = await createDecision(memexId, docId, "Lossless round trip");
    await setDecisionOptions(memexId, dec.id, [
      { label: "M", trade_offs: "mature" },
      { label: "N", trade_offs: "new" },
    ]);
    await resolveDecision(memexId, dec.id, "M for now.", 0);
    await deleteDecision(memexId, dec.id);

    const restored = await restoreDecision(memexId, dec.id, "resolved");
    expect(restored.status).toBe("resolved");
    expect(restored.resolution).toBe("M for now.");
    expect(restored.chosenOptionIndex).toBe(0);
    expect(restored.options).toEqual([
      { label: "M", trade_offs: "mature" },
      { label: "N", trade_offs: "new" },
    ]);
    expect(restored.previousStatus).toBeNull();
  });

  it("refuses to restore a decision that isn't deleted", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-3");
    const dec = await createDecision(memexId, docId, "Not deleted");
    await expect(restoreDecision(memexId, dec.id, "open")).rejects.toThrow(
      ValidationError,
    );
  });
});
