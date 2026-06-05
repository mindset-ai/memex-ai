// Integration tests for the t-10 standards service (doc-10 Slice 4). Exercises the
// service helpers against a real Postgres — service-level shape, account scoping, FTS
// behaviour, and drift comment creation.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  decisions,
  tasks,
} from "../db/schema.js";
import {
  listStandards,
  getStandard,
  createStandard,
  updateStandardByInstruction,
  flagDrift,
  findStandardsAffectedByDecision,
  getDecisionHandleById,
  scanForAmbiguousBareDecisionReferences,
  proposeStandardChange,
  buildProposedChangeBody,
  parseProposedChangeBody,
} from "./standards.js";
import { listComments } from "./comments.js";
import { createDocDraft } from "./documents.js";
import { createDecision } from "./decisions.js";
import { resolveComment } from "./comments.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length) {
    // doc_comments / doc_sections / decisions / tasks all cascade-delete from documents.
    await db.delete(tasks).where(inArray(tasks.docId, createdDocIds)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, createdDocIds)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex("bp");
});

describe("createStandard", () => {
  it("creates a docType='standard' document with sections", async () => {
    const bp = await createStandard(memexId, {
      title: "Caching",
      description: "How we cache reads in production",
      sections: [
        { sectionType: "do", content: "Use write-through caching [per dec-7]." },
        { sectionType: "dont", content: "Don't use TTL-based invalidation." },
      ],
    });
    createdDocIds.push(bp.id);

    expect(bp.docType).toBe("standard");
    expect(bp.status).toBe("draft");
    expect(bp.title).toBe("Caching");
    // description gets prepended as a leading 'description' section.
    expect(bp.sections.map((s) => s.sectionType)).toEqual(["description", "do", "dont"]);
    expect(bp.sections[0].content).toBe("How we cache reads in production");
    expect(bp.driftCount).toBe(0);
  });

  it("rejects an empty sections array", async () => {
    await expect(
      createStandard(memexId, { title: "Empty", sections: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects empty title", async () => {
    await expect(
      createStandard(memexId, {
        title: "   ",
        sections: [{ sectionType: "do", content: "..." }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects duplicate sectionType in input", async () => {
    await expect(
      createStandard(memexId, {
        title: "Dupes",
        sections: [
          { sectionType: "do", content: "x" },
          { sectionType: "do", content: "y" },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not double-insert 'description' if caller provides one", async () => {
    const bp = await createStandard(memexId, {
      title: "ManualDesc",
      description: "should be skipped",
      sections: [
        { sectionType: "description", content: "the real one" },
        { sectionType: "do", content: "..." },
      ],
    });
    createdDocIds.push(bp.id);
    const descSections = bp.sections.filter((s) => s.sectionType === "description");
    expect(descSections).toHaveLength(1);
    expect(descSections[0].content).toBe("the real one");
  });
});

describe("getStandard / listStandards", () => {
  it("getStandard returns sections in seq order with driftCount", async () => {
    const bp = await createStandard(memexId, {
      title: "GetMe",
      sections: [
        { sectionType: "overview", content: "summary" },
        { sectionType: "do", content: "do this" },
      ],
    });
    createdDocIds.push(bp.id);

    const fetched = await getStandard(memexId, bp.id);
    expect(fetched.id).toBe(bp.id);
    expect(fetched.sections.map((s) => s.sectionType)).toEqual(["overview", "do"]);
    expect(fetched.driftCount).toBe(0);
  });

  it("getStandard refuses non-standard docs", async () => {
    const spec = await createDocDraft(memexId, "NotAStandard", "purpose", "spec");
    createdDocIds.push(spec.id);
    await expect(getStandard(memexId, spec.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("getStandard 404s for cross-account access", async () => {
    const otherAccount = await makeTestMemex("other-bp");
    const bp = await createStandard(otherAccount, {
      title: "OtherAcct",
      sections: [{ sectionType: "do", content: "..." }],
    });
    createdDocIds.push(bp.id);
    await expect(getStandard(memexId, bp.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listStandards returns only standards with drift counts", async () => {
    // Seed a non-standard to verify filtering.
    const spec = await createDocDraft(memexId, "AnotherSpec", "p", "spec");
    createdDocIds.push(spec.id);

    const bp = await createStandard(memexId, {
      title: "WithDrift",
      sections: [{ sectionType: "do", content: "X [per dec-1]" }],
    });
    createdDocIds.push(bp.id);

    // Add an open drift comment.
    await flagDrift(memexId, bp.sections.find((s) => s.sectionType === "do")!.id, "code uses Y, not X");

    const list = await listStandards(memexId);
    const handles = list.map((b) => b.handle);
    // Spec should not appear.
    expect(handles).not.toContain(spec.handle);
    const found = list.find((b) => b.id === bp.id);
    expect(found).toBeDefined();
    expect(found!.driftCount).toBe(1);
    expect(found!.title).toBe("WithDrift");
  });
});

describe("flagDrift", () => {
  it("creates a comment_type='drift' source='agent' comment", async () => {
    const bp = await createStandard(memexId, {
      title: "DriftTarget",
      sections: [{ sectionType: "do", content: "use kubectl" }],
    });
    createdDocIds.push(bp.id);
    const sectionId = bp.sections.find((s) => s.sectionType === "do")!.id;

    const c = await flagDrift(memexId, sectionId, "Repo uses ArgoCD now.");
    expect(c.commentType).toBe("drift");
    expect(c.source).toBe("agent");
    expect(c.sectionId).toBe(sectionId);
    expect(c.content).toContain("ArgoCD");
  });

  it("rejects empty observations", async () => {
    const bp = await createStandard(memexId, {
      title: "RejectEmpty",
      sections: [{ sectionType: "do", content: "..." }],
    });
    createdDocIds.push(bp.id);
    const sectionId = bp.sections[0].id;
    await expect(flagDrift(memexId, sectionId, "  ")).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects flagging on non-standard doc sections", async () => {
    const spec = await createDocDraft(memexId, "AnotherSpec2", "p", "spec");
    createdDocIds.push(spec.id);
    const sectionId = spec.sections[0].id;
    await expect(flagDrift(memexId, sectionId, "x")).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not increment driftCount once resolved", async () => {
    const bp = await createStandard(memexId, {
      title: "ResolvedDrift",
      sections: [{ sectionType: "do", content: "..." }],
    });
    createdDocIds.push(bp.id);
    const sectionId = bp.sections[0].id;
    const c1 = await flagDrift(memexId, sectionId, "A");
    await flagDrift(memexId, sectionId, "B");

    const before = await getStandard(memexId, bp.id);
    expect(before.driftCount).toBe(2);

    await resolveComment(memexId, c1.id, "fixed");

    const after = await getStandard(memexId, bp.id);
    expect(after.driftCount).toBe(1);
  });
});

describe("updateStandardByInstruction", () => {
  it("records a plan_revision comment on the first section", async () => {
    const bp = await createStandard(memexId, {
      title: "Instructable",
      sections: [
        { sectionType: "overview", content: "summary" },
        { sectionType: "do", content: "..." },
      ],
    });
    createdDocIds.push(bp.id);

    const result = await updateStandardByInstruction(
      memexId,
      bp.id,
      "Update deployment guidance to reflect ArgoCD.",
    );
    expect(result.instructionComment.commentType).toBe("plan_revision");
    expect(result.instructionComment.source).toBe("agent");
    // Anchored to the first section by seq.
    const firstSection = bp.sections.find((s) => s.seq === 1);
    expect(result.instructionComment.sectionId).toBe(firstSection!.id);
    expect(result.instructionComment.content).toContain("ArgoCD");
  });

  it("rejects empty instruction", async () => {
    const bp = await createStandard(memexId, {
      title: "Empty",
      sections: [{ sectionType: "do", content: "..." }],
    });
    createdDocIds.push(bp.id);
    await expect(
      updateStandardByInstruction(memexId, bp.id, "   "),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("404s when the doc isn't a standard", async () => {
    const spec = await createDocDraft(memexId, "InstrSpec", "p", "spec");
    createdDocIds.push(spec.id);
    await expect(
      updateStandardByInstruction(memexId, spec.id, "do something"),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("findStandardsAffectedByDecision (FTS)", () => {
  it("finds standard sections mentioning [per dec-N]", async () => {
    // Spec doc with a real decision.
    const spec = await createDocDraft(memexId, "StratFTS", "purpose", "spec");
    createdDocIds.push(spec.id);
    await createDecision(memexId, spec.id, "Cache invalidation spec");
    await createDecision(memexId, spec.id, "TTL window");
    await createDecision(memexId, spec.id, "Eviction policy");
    await createDecision(memexId, spec.id, "Replication factor");
    await createDecision(memexId, spec.id, "Read consistency");
    await createDecision(memexId, spec.id, "Multi-region");
    await createDecision(memexId, spec.id, "Sticky sessions");
    // 7th decision is the one we'll reference.
    const dec7 = await createDecision(memexId, spec.id, "Backplane choice");
    expect(dec7.seq).toBe(8); // (7 prior + this one) — handle sequence is per doc

    // Two standards reference dec-8; one references dec-3 (different decision).
    const bp1 = await createStandard(memexId, {
      title: "Caching",
      sections: [
        { sectionType: "do", content: "Use write-through invalidation [per dec-8]." },
        { sectionType: "dont", content: "No reference here" },
      ],
    });
    createdDocIds.push(bp1.id);
    const bp2 = await createStandard(memexId, {
      title: "Deployment",
      sections: [
        { sectionType: "verify", content: "Per [per dec-8] all cache reads route through layer 7." },
      ],
    });
    createdDocIds.push(bp2.id);
    const bp3 = await createStandard(memexId, {
      title: "Routing",
      sections: [
        { sectionType: "do", content: "Use Envoy [per dec-3]." },
      ],
    });
    createdDocIds.push(bp3.id);

    const matches = await findStandardsAffectedByDecision(memexId, "dec-8");
    const matchIds = matches.map((m) => m.standard.id).sort();
    expect(matchIds).toEqual([bp1.id, bp2.id].sort());
    // bp1 should have one matching section (the 'do' one), bp2 should have one too.
    const bp1Match = matches.find((m) => m.standard.id === bp1.id)!;
    expect(bp1Match.matchingSections).toHaveLength(1);
    expect(bp1Match.matchingSections[0].sectionType).toBe("do");
  });

  it("normalises 'dec-7', 'DEC-7', and bare '7' inputs", async () => {
    const bp = await createStandard(memexId, {
      title: "NormaliseTarget",
      sections: [{ sectionType: "do", content: "rule [per dec-42]" }],
    });
    createdDocIds.push(bp.id);

    const a = await findStandardsAffectedByDecision(memexId, "dec-42");
    const b = await findStandardsAffectedByDecision(memexId, "DEC-42");
    const c = await findStandardsAffectedByDecision(memexId, "42");
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(c.length);
    expect(a.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects malformed handles", async () => {
    await expect(
      findStandardsAffectedByDecision(memexId, "not-a-handle"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("excludes false positives where 'dec' and 'N' appear separately", async () => {
    // A standard that contains 'dec' and 'N' in unrelated text but no `[per dec-N]`.
    const bp = await createStandard(memexId, {
      title: "FalsePositiveCheck",
      sections: [
        {
          sectionType: "do",
          content: "Decision 99 was made (see also note 99). No bracket reference here.",
        },
      ],
    });
    createdDocIds.push(bp.id);

    const matches = await findStandardsAffectedByDecision(memexId, "dec-99");
    const matched = matches.find((m) => m.standard.id === bp.id);
    // FTS may surface this candidate, but the literal post-filter must drop it.
    expect(matched).toBeUndefined();
  });

  it("does not leak across memexes", async () => {
    const otherAccount = await makeTestMemex("other-fts");
    const bp = await createStandard(otherAccount, {
      title: "OtherAcctFts",
      sections: [{ sectionType: "do", content: "rule [per dec-1]" }],
    });
    createdDocIds.push(bp.id);

    const matches = await findStandardsAffectedByDecision(memexId, "dec-1");
    expect(matches.find((m) => m.standard.id === bp.id)).toBeUndefined();
  });
});

describe("getDecisionHandleById", () => {
  it("returns dec-N for an in-account decision", async () => {
    const spec = await createDocDraft(memexId, "HandleStrat", "purpose", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(memexId, spec.id, "First question");
    const handle = await getDecisionHandleById(memexId, dec.id);
    expect(handle).toBe(`dec-${dec.seq}`);
  });

  it("404s for cross-account access", async () => {
    const otherAccount = await makeTestMemex("other-handle");
    const spec = await createDocDraft(otherAccount, "OtherStrat", "p", "spec");
    createdDocIds.push(spec.id);
    const dec = await createDecision(otherAccount, spec.id, "x?");
    await expect(getDecisionHandleById(memexId, dec.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("scanForAmbiguousBareDecisionReferences (t-20 W-A)", () => {
  it("flags standard sections with bare references that match multiple decisions", async () => {
    const acc = await makeTestMemex("ambig-scan");
    // Two strategies in the same account, both with a dec-1 → bare `dec-1`
    // is ambiguous. Plus a third spec with its own decision so we can
    // verify single-match references are skipped.
    const specA = await createDocDraft(acc, "Ambig A", "Purpose", "spec");
    const specB = await createDocDraft(acc, "Ambig B", "Purpose", "spec");
    const specC = await createDocDraft(acc, "Ambig C", "Purpose", "spec");
    createdDocIds.push(specA.id, specB.id, specC.id);
    await createDecision(acc, specA.id, "A's first");
    await createDecision(acc, specB.id, "B's first");
    // specC's first decision will reach seq 1 too — but we won't reference
    // it from a standard, so it just adds another candidate to the bare set.
    await createDecision(acc, specC.id, "C's first (third candidate)");

    // Standard with a bare `[per dec-1]` (ambiguous) and a qualified
    // `[per doc-X:dec-1]` (always unambiguous, must be skipped).
    const bp = await createStandard(acc, {
      title: "Ambig Refs Standard",
      sections: [
        {
          sectionType: "do",
          content: "Always do X [per dec-1]; also see [per doc-1:dec-1].",
        },
        {
          sectionType: "verify",
          content: "Confirm Y per [per dec-99].", // no decisions, harmless
        },
      ],
    });
    createdDocIds.push(bp.id);

    const result = await scanForAmbiguousBareDecisionReferences(acc);
    expect(result.ambiguousReferencesFound).toBe(1);
    expect(result.newDriftCommentsPosted).toBe(1);
    expect(result.standardsScanned).toBeGreaterThanOrEqual(1);

    // The drift comment landed on the section that contained the ambiguous ref.
    const targetSection = bp.sections.find((s) => s.sectionType === "do")!;
    const comments = await listComments(acc, targetSection.id, {
      typeFilter: "drift",
    });
    expect(comments.length).toBe(1);
    expect(comments[0].content).toContain("dec-1");
    expect(comments[0].content).toContain("ambiguous reference");
    expect(comments[0].source).toBe("agent");

    // Idempotent — re-running posts no new comments.
    const second = await scanForAmbiguousBareDecisionReferences(acc);
    expect(second.newDriftCommentsPosted).toBe(0);
    expect(second.ambiguousReferencesFound).toBe(1);
  });

  it("does NOT flag qualified references or single-match bare references", async () => {
    const acc = await makeTestMemex("ambig-clean");
    const spec = await createDocDraft(acc, "Solo", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await createDecision(acc, spec.id, "Lonely decision");

    const bp = await createStandard(acc, {
      title: "Clean Standard",
      sections: [
        // Bare reference resolves to one decision in this account → not ambiguous.
        { sectionType: "do", content: "Solo rule [per dec-1]." },
        // Qualified reference is always skipped by the scan.
        { sectionType: "verify", content: "Cross [per doc-2:dec-1] check." },
      ],
    });
    createdDocIds.push(bp.id);

    const result = await scanForAmbiguousBareDecisionReferences(acc);
    expect(result.ambiguousReferencesFound).toBe(0);
    expect(result.newDriftCommentsPosted).toBe(0);
  });
});

describe("proposeStandardChange (t-8)", () => {
  it("posts a plan_revision typed comment with the proposal body and source=agent", async () => {
    const bp = await createStandard(memexId, {
      title: "Propose target",
      sections: [{ sectionType: "do", content: "Always cache writes." }],
    });
    createdDocIds.push(bp.id);
    const sectionId = bp.sections[0].id;

    const result = await proposeStandardChange(
      memexId,
      sectionId,
      "Cache writes through, except for mutating endpoints.",
      "observed pattern in repo",
    );

    expect(result.standard.id).toBe(bp.id);
    expect(result.section.id).toBe(sectionId);
    expect(result.comment.commentType).toBe("plan_revision");
    expect(result.comment.source).toBe("agent");

    // Body must round-trip through the parser so the React UI (t-12) can extract
    // the proposed text without ambiguity.
    const parsed = parseProposedChangeBody(result.comment.content);
    expect(parsed?.proposed).toBe(
      "Cache writes through, except for mutating endpoints.",
    );
  });

  it("rejects empty proposedContent", async () => {
    const bp = await createStandard(memexId, {
      title: "Empty proposal target",
      sections: [{ sectionType: "do", content: "x" }],
    });
    createdDocIds.push(bp.id);
    await expect(
      proposeStandardChange(memexId, bp.sections[0].id, "  "),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects sections that don't belong to a standard", async () => {
    const draft = await createDocDraft(memexId, "Spec doc", "Purpose", "spec");
    createdDocIds.push(draft.id);
    await expect(
      proposeStandardChange(
        memexId,
        draft.sections[0].id,
        "Some replacement",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("buildProposedChangeBody and parseProposedChangeBody round-trip arbitrary content", () => {
    const body = buildProposedChangeBody(
      "rule-1",
      "Line 1\nLine 2\n```code``` inside",
      "rationale here",
    );
    const parsed = parseProposedChangeBody(body);
    expect(parsed?.proposed).toBe("Line 1\nLine 2\n```code``` inside");
    expect(body).toContain("rationale here");
  });
});
