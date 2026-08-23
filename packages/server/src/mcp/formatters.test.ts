import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as formatters from "./formatters.js";
import {
  formatSpecGuidance,
  formatFullDocState,
  formatDocList,
  formatComment,
  formatDocComments,
  formatCommentList,
  formatReviewComments,
} from "./formatters.js";
import type { Doc, DocSection, DocComment } from "../db/schema.js";
import type { DocSummary } from "../types/index.js";
import { BASE_SCAFFOLD } from "@memex/shared";
import { tagAc } from "@memex-ai-ac/vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const baseDate = new Date("2026-03-25T12:00:00Z");

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: "doc-uuid-1",
    memexId: "test-account",
    handle: "doc-1",
    title: "Test Doc",
    // b-105: `"spec"` is the canonical Spec docType, which routes through
    // phase-based guidance. The legacy data-shape tests below need a generic
    // free-form docType to keep exercising the legacy code path, so the
    // default is `"document"` (the catch-all).
    docType: "document",
    description: null,
    skillCapabilities: null,
    status: "draft",
    parentDocId: null,
    createdByUserId: null,
    createdAt: baseDate,
    statusChangedAt: baseDate,
    archivedAt: null,
    // spec-521: archive attribution + supersession pointers (nullable, unset here).
    archiveReason: null,
    archivedByUserId: null,
    archivedByName: null,
    supersededByDocId: null,
    supersededAt: null,
    supersessionNote: null,
    narrativeLastConsolidatedAt: null,
    isDemo: false,
    groundedInCode: false,
    groundedAt: null,
    groundedByUserId: null,
    groundedByName: null,
    sensitive: false,
    sensitiveByUserId: null,
    sensitiveByName: null,
    checkedOutBy: null,
    checkedOutAt: null,
    checkedOutThread: null,
    version: 1,
    ...overrides,
  };
}

function makeSection(overrides: Partial<DocSection> = {}): DocSection {
  return {
    id: "section-uuid-1",
    docId: "doc-uuid-1",
    sectionType: "purpose",
    title: "Purpose",
    description: null,
    content: "Some purpose content.",
    seq: 1,
    preamble: null,
    position: 1,
    status: "active",
    previousStatus: null,
    retiredAtVersion: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    actorUserId: null,
    actorName: null,
    channel: null,
    ...overrides,
  };
}

function makeComment(overrides: Partial<DocComment> = {}): DocComment {
  return {
    id: "comment-uuid-1",
    memexId: "test-account",
    docId: "doc-uuid-1",
    seq: 1,
    sectionId: "section-uuid-1",
    decisionId: null,
    taskId: null,
    driftDecisionId: null,
    authorName: "Alice",
    authorUserId: null,
    authorNamespaceId: null,
    content: "Looks good!",
    commentType: "discussion",
    source: "human",
    referenceBriefId: null,
    referenceStandardId: null,
    referenceDecisionId: null,
    referenceTaskId: null,
    resolution: null,
    resolvedAt: null,
    anchorSnippet: null,
    audience: "all",
    actions: null,
    assigneeUserId: null,
    assignedBy: null,
    assignedAt: null,
    retiredAtVersion: null,
    channel: null,
    createdAt: baseDate,
    ...overrides,
  };
}

describe("formatFullDocState", () => {
  it("renders a document with sections", () => {
    const doc = { ...makeDoc(), sections: [makeSection()] };
    const result = formatFullDocState(doc, [], []);

    expect(result).toContain("# Test Doc [DRAFT]");
    expect(result).toContain("Type: document");
    expect(result).toContain("Handle: doc-1");
    expect(result).toContain("## 1. Purpose");
    expect(result).toContain("Some purpose content.");
    expect(result).toContain("Section #1");
  });

  // spec-106 ac-9: the section's `sectionType` machine key is part of the read
  // surface (rendered in the per-section metadata line).
  it("renders the sectionType in the section metadata line (spec-106 ac-9)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-106/acs/ac-9");
    const doc = { ...makeDoc(), sections: [makeSection({ sectionType: "scope" })] };
    const result = formatFullDocState(doc, [], []);
    expect(result).toContain("Type: scope");
  });

  // spec-106 ac-10: a populated `description` travels next to the sectionType.
  it("renders a populated description in the section metadata line (spec-106 ac-10)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-106/acs/ac-10");
    const doc = {
      ...makeDoc(),
      sections: [makeSection({ description: "What this section is for" })],
    };
    const result = formatFullDocState(doc, [], []);
    expect(result).toContain("Description: What this section is for");
  });

  // spec-106 ac-10: a NULL description stays terse — no empty "Description:" segment.
  it("omits the Description segment when description is null (spec-106 ac-10)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-106/acs/ac-10");
    const doc = { ...makeDoc(), sections: [makeSection({ description: null })] };
    const result = formatFullDocState(doc, [], []);
    expect(result).not.toContain("Description:");
  });

  it("includes URL when appBaseUrl provided", () => {
    const doc = { ...makeDoc(), sections: [] };
    const result = formatFullDocState(doc, [], [], "https://app.memex.ai");

    expect(result).toContain("URL: https://app.memex.ai/docs/doc-1");
  });

  it("shows legacy Phase 1 guidance for a Spec with an unknown status (no decisions)", () => {
    // b-105: a Spec in a recognised phase routes through phase-based guidance;
    // an unrecognised status falls back to the legacy data-shape inference.
    const doc = { ...makeDoc({ docType: "spec", status: "wat" }), sections: [makeSection()] };
    const result = formatSpecGuidance(doc, [], []);

    expect(result).toContain("Next: Identify Decisions");
    expect(result).toContain("create_decision");
  });

  it("shows legacy Phase 2 guidance for a Spec with an unknown status (open decisions)", () => {
    const doc = { ...makeDoc({ docType: "spec", status: "wat" }), sections: [makeSection()] };
    const decs = [{
      id: "dec-uuid-1", memexId: "test-account", docId: "doc-uuid-1", seq: 1,
      title: "Which database?", context: "Postgres vs MySQL",
      status: "open", options: null, chosenOptionIndex: null,
      source: "human" as const,
      resolution: null, resolvedAt: null, previousStatus: null, retiredAtVersion: null, createdAt: baseDate,
      actorUserId: null, actorName: null, channel: null,
    }];
    const result = formatSpecGuidance(doc, decs, []);

    expect(result).toContain("Remaining: 1 Open Decision");
    expect(result).toContain("Which database?");
  });

  it("does not emit Spec guidance for non-Spec docTypes", () => {
    // Free-form documents (docType="document") and other custom docTypes never
    // trigger Spec guidance — neither phase nor legacy fallback.
    const doc = { ...makeDoc({ docType: "runbook" }), sections: [] };
    const result = formatFullDocState(doc, [], []);

    expect(result).not.toContain("Next: Identify Decisions");
  });

  it("shows comment count badge on tasks with comments", () => {
    const doc = { ...makeDoc({ docType: "runbook" }), sections: [] };
    const task = {
      id: "task-uuid-1",
      docId: "doc-uuid-1",
      memexId: "acc-uuid-1",
      seq: 1,
      title: "Ship database schema",
      description: "",
      skillCapabilities: null,
      status: "not_started",
      sectionRef: null,
      acceptanceCriteria: [],
      executionPlanDocId: null,
      retiredAtVersion: null,
      createdAt: baseDate,
      updatedAt: baseDate,
      startedAt: null,
      completedAt: null,
      blocked: false,
      blockedByDecisions: [],
      blockedByTasks: [],
      actorUserId: null,
      actorName: null,
      channel: null,
    };
    const comments = {
      sections: [],
      decisions: [],
      tasks: [
        {
          task: task,
          comments: [
            makeComment({ id: "c1", taskId: "task-uuid-1", sectionId: null }),
            makeComment({ id: "c2", taskId: "task-uuid-1", sectionId: null }),
            makeComment({ id: "c3", taskId: "task-uuid-1", sectionId: null, resolvedAt: baseDate }),
          ],
        },
      ],
    };
    const result = formatFullDocState(doc, [], [task], undefined, comments);

    expect(result).toContain('"Ship database schema" [2 open, 1 resolved comments]');
  });

  it("omits comment badge for tasks with no comments", () => {
    const doc = { ...makeDoc({ docType: "runbook" }), sections: [] };
    const task = {
      id: "task-uuid-2",
      docId: "doc-uuid-1",
      memexId: "acc-uuid-1",
      seq: 2,
      title: "Untouched task",
      description: "",
      skillCapabilities: null,
      status: "not_started",
      sectionRef: null,
      acceptanceCriteria: [],
      executionPlanDocId: null,
      retiredAtVersion: null,
      createdAt: baseDate,
      updatedAt: baseDate,
      startedAt: null,
      completedAt: null,
      blocked: false,
      blockedByDecisions: [],
      blockedByTasks: [],
      actorUserId: null,
      actorName: null,
      channel: null,
    };
    const result = formatFullDocState(doc, [], [task], undefined, {
      sections: [],
      decisions: [],
      tasks: [],
    });

    expect(result).toContain('"Untouched task"');
    expect(result).not.toContain("open comments");
    expect(result).not.toContain("resolved comment");
  });
});

describe("formatDocList", () => {
  it("renders a list of documents", () => {
    const docs: DocSummary[] = [
      {
        id: "doc-uuid-1",
        memexId: "test-account",
        handle: "doc-1",
        title: "First Doc",
        docType: "spec",
        status: "draft",
        parentDocId: null,
        createdAt: baseDate,
        statusChangedAt: baseDate,
        sectionCount: 3,
        archivedAt: null,
      },
      {
        id: "doc-uuid-2",
        memexId: "test-account",
        handle: "doc-2",
        title: "Second Doc",
        docType: "spec",
        status: "done",
        parentDocId: null,
        createdAt: baseDate,
        statusChangedAt: baseDate,
        sectionCount: 5,
        archivedAt: null,
      },
    ];
    const result = formatDocList(docs, "http://localhost:5173");

    expect(result).toContain("# Documents");
    expect(result).toContain("**First Doc**");
    expect(result).toContain("type: spec");
    expect(result).toContain("**Second Doc**");
    expect(result).toContain("type: spec");
    expect(result).toContain("[DONE]");
    expect(result).toContain("status changed 2026-03-25");
    expect(result).toContain("2 documents total");
  });

  it("handles empty list", () => {
    const result = formatDocList([]);
    expect(result).toContain("0 documents total");
  });
});

describe("formatComment", () => {
  it("renders open comment", () => {
    const result = formatComment(makeComment());

    expect(result).toContain("[OPEN]");
    expect(result).toContain("**Alice**");
    expect(result).toContain("Looks good!");
    // b-36 T-6: formatter output no longer emits raw UUIDs. When the caller
    // passes slugs+doc context the leading line becomes `ref: <path>`; with
    // no context the comment renders without an identifier line.
    expect(result).not.toContain("comment-uuid-1");
  });

  it("renders resolved comment", () => {
    const result = formatComment(makeComment({ resolvedAt: baseDate }));

    expect(result).toContain("[RESOLVED]");
  });

  it("includes resolution when present", () => {
    const result = formatComment(
      makeComment({
        resolvedAt: baseDate,
        resolution: "Updated scope section",
      })
    );

    expect(result).toContain("[RESOLVED]");
    expect(result).toContain("Resolution: Updated scope section");
  });
});

describe("formatDocComments", () => {
  it("returns empty message when no comments", () => {
    const result = formatDocComments({ sections: [], decisions: [], tasks: [] });
    expect(result).toBe("No comments on this document.");
  });

  it("groups comments by section", () => {
    const result = formatDocComments({
      sections: [
        {
          section: makeSection(),
          comments: [makeComment(), makeComment({ id: "c2", memexId: "test-account", content: "Another" })],
        },
      ],
      decisions: [],
      tasks: [],
    });

    expect(result).toContain("# Comments (2 total)");
    expect(result).toContain("## Section: Purpose");
    expect(result).toContain("Looks good!");
    expect(result).toContain("Another");
  });
});

describe("formatReviewComments", () => {
  it("returns empty message when no open comments", () => {
    const result = formatReviewComments({ sections: [], decisions: [], tasks: [] });
    expect(result).toBe("No open comments to review.");
  });

  it("includes section content alongside comments", () => {
    const result = formatReviewComments({
      sections: [
        {
          section: makeSection({ content: "The full section text here." }),
          comments: [makeComment({ content: "Please expand this" })],
        },
      ],
      decisions: [],
      tasks: [],
    });

    expect(result).toContain("# Review: 1 open comments");
    expect(result).toContain("### Current content");
    expect(result).toContain("The full section text here.");
    expect(result).toContain("### Open comments (1)");
    expect(result).toContain("Please expand this");
  });
});

describe("formatCommentList", () => {
  it("returns empty message when no comments", () => {
    const result = formatCommentList([]);
    expect(result).toBe("No comments on this section.");
  });

  it("separates open and resolved comments", () => {
    const comments = [
      makeComment({ id: "c1", memexId: "test-account", content: "Open one" }),
      makeComment({ id: "c2", memexId: "test-account", content: "Resolved one", resolvedAt: baseDate }),
    ];
    const result = formatCommentList(comments);

    expect(result).toContain("1 open, 1 resolved");
    expect(result).toContain("Open one");
    expect(result).toContain("## Resolved");
    expect(result).toContain("Resolved one");
  });
});

describe("spec phase guidance — specify/draft code-grounding nudge", () => {
  const CANONICAL_PHRASE =
    "Ground code-touching decisions against current source before resolving (the specify prompt covers this).";

  it("includes the code-grounding nudge when a Spec is in `draft`", () => {
    const doc = {
      ...makeDoc({ docType: "spec", status: "draft" }),
      sections: [makeSection()],
    };
    const result = formatSpecGuidance(doc, [], []);

    expect(result).toContain(CANONICAL_PHRASE);
  });

  it("includes the code-grounding nudge when a Spec is in `specify`", () => {
    const doc = {
      ...makeDoc({ docType: "spec", status: "specify" }),
      sections: [makeSection()],
    };
    const result = formatSpecGuidance(doc, [], []);

    expect(result).toContain(CANONICAL_PHRASE);
  });

  it("omits the code-grounding nudge when a Spec is in `build`", () => {
    const doc = {
      ...makeDoc({ docType: "spec", status: "build" }),
      sections: [makeSection()],
    };
    const result = formatSpecGuidance(doc, [], []);

    expect(result).not.toContain(CANONICAL_PHRASE);
  });

  it("omits the code-grounding nudge when a Spec is in `verify`", () => {
    const doc = {
      ...makeDoc({ docType: "spec", status: "verify" }),
      sections: [makeSection()],
    };
    const result = formatSpecGuidance(doc, [], []);

    expect(result).not.toContain(CANONICAL_PHRASE);
  });

  it("omits the code-grounding nudge when a Spec is in `done`", () => {
    const doc = {
      ...makeDoc({ docType: "spec", status: "done" }),
      sections: [makeSection()],
    };
    const result = formatSpecGuidance(doc, [], []);

    expect(result).not.toContain(CANONICAL_PHRASE);
  });
});

// ════════════════════════════════════════════════════════════════════
// b-68 t-7 AC-tagged guards
// ════════════════════════════════════════════════════════════════════

describe("b-68 t-7 ac-22: formatPhaseGuidance retired; per-phase prose flows through toNudge", () => {
  it("formatPhaseGuidance is NOT exported from formatters.ts", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-22");
    // Static import surface check — guards against accidental re-export. The
    // function used to compose the phase footer (`formatPhaseGuidance` +
    // `phaseAllowanceLine` + `phaseIntentLine`) was removed in t-7 in favour
    // of `toNudge` over BASE_SCAFFOLD.
    expect((formatters as Record<string, unknown>).formatPhaseGuidance).toBeUndefined();
  });

  it("an MCP-formatted spec response includes content sourced from toNudge / BASE_SCAFFOLD per-phase guidance", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-22");
    // Pull a sentinel string from BASE_SCAFFOLD's specify-intent block — this
    // text now arrives in the rendered output exclusively through `toNudge`.
    const specifyIntent = BASE_SCAFFOLD.baseGuidance.find(
      (g) =>
        g.target.phase === "specify" &&
        g.target.tool === undefined &&
        g.target.transition === undefined &&
        g.text.startsWith("**Phase:** specify"),
    );
    expect(specifyIntent, "BASE_SCAFFOLD must carry a `specify` phase-intent block").toBeDefined();
    const doc = {
      ...makeDoc({ docType: "spec", status: "specify" }),
      sections: [makeSection()],
    };
    const result = formatSpecGuidance(doc, [], []);
    expect(result).toContain(specifyIntent!.text);
  });
});

describe("b-68 t-7 ac-24: allowance prose derives from BASE_SCAFFOLD.phases[<phase>].allowance", () => {
  it("formatters.ts source no longer mentions `phaseAllowanceLine` or `phaseIntentLine`", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-24");
    // spec-368 sol-4: formatter body moved to the neutral module; scan it there.
    const formattersSrc = readFileSync(
      resolve(__dirname, "..", "formatting", "formatters.ts"),
      "utf8",
    );
    // Negative test: legacy helper names are gone. Catches accidental
    // resurrections of the switch-statement allowance formatter.
    expect(formattersSrc).not.toContain("phaseAllowanceLine");
    expect(formattersSrc).not.toContain("phaseIntentLine");
  });

  it.each(["draft", "specify", "build"] as const)(
    "the rendered allowance line names every `allowed` tool from BASE_SCAFFOLD.phases.%s.allowance",
    (phase) => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-24");
      const node = BASE_SCAFFOLD.phases.find((p) => p.phase === phase);
      expect(node, `BASE_SCAFFOLD must carry a phase node for ${phase}`).toBeDefined();
      const doc = {
        ...makeDoc({ docType: "spec", status: phase }),
        sections: [makeSection()],
      };
      const rendered = formatSpecGuidance(doc, [], []);
      // For draft/specify the allowance line spells every allowed tool out
      // (build's allowance line is the legacy compressed phrase, asserted
      // separately below).
      if (phase === "draft" || phase === "specify") {
        for (const tool of node!.allowance.allowed) {
          expect(rendered).toContain(`\`${tool}\``);
        }
      }
    },
  );

  it("the rendered allowance line carries the blocked-set summary for specify ('task creation (`create_task`), execution plans')", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-24");
    const specifyNode = BASE_SCAFFOLD.phases.find((p) => p.phase === "specify");
    expect(specifyNode?.allowance.blocked).toEqual(
      expect.arrayContaining(["create_task", "execution_plans"]),
    );
    const doc = {
      ...makeDoc({ docType: "spec", status: "specify" }),
      sections: [makeSection()],
    };
    const rendered = formatSpecGuidance(doc, [], []);
    expect(rendered).toMatch(/Blocked now:\*\* task creation \(`create_task`\), execution plans/);
  });
});

// b-97 t-1: decisions with options and chosenOptionIndex must surface both
// inline so an agent reading get_doc output can see what was chosen and what
// the alternatives were without a follow-up tool call. Decisions WITHOUT
// options keep their pre-b-97 rendering byte-identical.
describe("formatDecision (b-97)", () => {
  function makeDecision(overrides: Partial<{
    id: string;
    memexId: string;
    docId: string;
    seq: number;
    title: string;
    context: string | null;
    status: string;
    options: unknown;
    chosenOptionIndex: number | null;
    source: "human" | "agent";
    resolution: string | null;
    resolvedAt: Date | null;
    previousStatus: string | null;
    createdAt: Date;
  }> = {}) {
    return {
      id: "dec-uuid-1",
      memexId: "test-account",
      docId: "doc-uuid-1",
      seq: 1,
      title: "Which database?",
      context: null,
      status: "open",
      options: null,
      chosenOptionIndex: null,
      source: "human" as const,
      resolution: null,
      resolvedAt: null,
      previousStatus: null,
      retiredAtVersion: null,
      createdAt: baseDate,
      actorUserId: null,
      actorName: null,
      channel: null,
      ...overrides,
    };
  }

  const briefDoc = makeDoc({ docType: "spec", handle: "spec-3", status: "build" });

  it("renders resolved decision with chosen option label inline (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-4");
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-1");
    const decs = [
      makeDecision({
        title: "Which database?",
        status: "resolved",
        options: [
          { label: "Postgres", trade_offs: "ACID, mature" },
          { label: "MySQL", trade_offs: "Wide hosting support" },
        ],
        chosenOptionIndex: 0,
        resolution: "Postgres for ACID and JSONB.",
        resolvedAt: baseDate,
      }),
    ];
    const result = formatFullDocState(
      { ...briefDoc, sections: [makeSection()] },
      decs,
      [],
    );

    // Title + resolution arrow stays on one line.
    expect(result).toContain('[RESOLVED]: "Which database?" → "Postgres for ACID and JSONB."');
    // New `Chose:` line is right beneath the title→resolution line.
    expect(result).toContain("  Chose: Postgres");
  });

  it("renders the options block on candidate/open decisions with the chosen marker (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-4");
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-2");
    const decs = [
      makeDecision({
        status: "candidate",
        options: [
          { label: "Soft delete", trade_offs: "Reversible" },
          { label: "Hard delete", trade_offs: "Irrecoverable" },
        ],
        chosenOptionIndex: null,
      }),
    ];
    const result = formatFullDocState(
      { ...briefDoc, sections: [makeSection()] },
      decs,
      [],
    );

    expect(result).toContain("  Options:");
    expect(result).toContain("    0. Soft delete");
    expect(result).toContain("       Trade-offs: Reversible");
    expect(result).toContain("    1. Hard delete");
    // No chosen yet → no CHOSEN marker anywhere in the block.
    expect(result).not.toContain("← CHOSEN");
  });

  it("marks the chosen option in the options block on resolved decisions (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-4");
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-1");
    const decs = [
      makeDecision({
        status: "resolved",
        options: [
          { label: "Option A", trade_offs: "x" },
          { label: "Option B", trade_offs: "y" },
        ],
        chosenOptionIndex: 1,
        resolution: "Option B for reasons.",
        resolvedAt: baseDate,
      }),
    ];
    const result = formatFullDocState(
      { ...briefDoc, sections: [makeSection()] },
      decs,
      [],
    );

    expect(result).toContain("    0. Option A");
    expect(result).toContain("    1. Option B ← CHOSEN");
  });

  it("renders decisions without options byte-identically to pre-b-97 shape (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-4");
    const decs = [
      makeDecision({
        title: "Pick a deployment region",
        context: "Latency vs cost",
        status: "resolved",
        resolution: "europe-west2.",
        resolvedAt: baseDate,
      }),
    ];
    const result = formatFullDocState(
      { ...briefDoc, sections: [makeSection()] },
      decs,
      [],
    );

    // No Chose: / Options: surface when the decision was resolved without
    // going through the option picker.
    expect(result).not.toContain("Chose:");
    expect(result).not.toContain("Options:");
    // Legacy line shape is preserved.
    expect(result).toContain('[RESOLVED]: "Pick a deployment region" → "europe-west2."');
    expect(result).toContain("  Context: Latency vs cost");
  });

  it("guards against out-of-bounds chosenOptionIndex (defence in depth)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-4");
    const decs = [
      makeDecision({
        status: "resolved",
        options: [{ label: "Only option", trade_offs: "x" }],
        // The service rejects this on resolve, but the formatter should not
        // crash if a stale row makes it through.
        chosenOptionIndex: 5,
        resolution: "stale",
        resolvedAt: baseDate,
      }),
    ];
    expect(() =>
      formatFullDocState(
        { ...briefDoc, sections: [makeSection()] },
        decs,
        [],
      ),
    ).not.toThrow();
  });
});

// ── spec-535 t-5: the sensitivity warning block ────────────────────────────
//
// dec-3 put this in the MCP HEADER, not the guidance footer, for two reasons the
// tests below encode: the footer renders at the bottom of a long read (the
// weakest position for something that must land before editing starts), and
// spec-510 is rewriting its cadence to "once per session, pointer thereafter" —
// under which Spec A's warning could be suppressed because Spec B already spent
// the session's emission. A per-Spec safety warning cannot live on a seat whose
// rule is "do not repeat yourself".
describe("spec-535: the sensitivity warning block", () => {
  const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;

  const flagged = () =>
    makeDoc({ sensitive: true, sensitiveByName: "Robin", sensitiveByUserId: "u-1" });

  it("ac-10: renders after the header's key/value lines and before the first section", () => {
    tagAc(AC(10));
    const doc = { ...flagged(), sections: [makeSection()] };
    const out = formatters.formatFullDocState(doc, [], []);

    expect(out).toContain("Robin");

    // Position is the whole point: it must be the last thing read before the
    // content, not buried after it.
    const handleAt = out.indexOf("Handle: doc-1");
    const blockAt = out.indexOf("Robin");
    const firstSectionAt = out.indexOf("## 1.");
    expect(blockAt).toBeGreaterThan(handleAt);
    expect(blockAt).toBeLessThan(firstSectionAt);
  });

  it("ac-10: it is a distinct block, never another `Key: value` line", () => {
    tagAc(AC(10));
    const out = formatters.formatFullDocState({ ...flagged(), sections: [] }, [], []);

    // The failure this guards against is cosmetic-looking and fatal: `Sensitive:
    // true` sitting among `Type:` and `Status:` reads as metadata and gets
    // skimmed — spec-240 dec-1 recorded a weak model doing exactly that.
    expect(out).not.toMatch(/^Sensitive: /m);
    // A warning spans more than one line and is visually separated.
    const marked = out.split("\n").filter((l) => l.includes("⚠"));
    expect(marked.length).toBeGreaterThan(1);
  });

  it("ac-12: carries the flag, who flagged it, and the action — and stays portable", () => {
    tagAc(AC(12));
    const out = formatters.formatFullDocState({ ...flagged(), sections: [] }, [], []);

    expect(out).toContain("Robin");
    expect(out.toLowerCase()).toContain("contact");
    // std-22: this renders against arbitrary codebases. No repo paths, no tool
    // names, no Standard handles in the copy.
    const block = out.split("\n").filter((l) => l.includes("⚠")).join("\n");
    expect(block).not.toMatch(/packages\/|src\//);
    expect(block).not.toMatch(/\bstd-\d+\b/);
    expect(block).not.toMatch(/vitest|pnpm|set_sensitive/);
  });

  it("ac-12: says the warning blocks nothing, so a reader does not treat it as a lock", () => {
    tagAc(AC(12));
    const out = formatters.formatFullDocState({ ...flagged(), sections: [] }, [], []);
    // ac-3's promise has to be legible AT the warning, or a cautious agent will
    // stop when the Spec explicitly does not want it to.
    expect(out.toLowerCase()).toMatch(/blocks nothing|not a lock|advisory/);
  });

  it("ac-11: an unflagged doc renders nothing — no block, no orphan delimiter", () => {
    tagAc(AC(11));
    const out = formatters.formatFullDocState({ ...makeDoc(), sections: [makeSection()] }, [], []);
    expect(out).not.toContain("⚠");
    expect(out).not.toMatch(/sensitive/i);
  });

  it("ac-11: a flagged doc with no recorded name still warns, naming no one", () => {
    tagAc(AC(11));
    const doc = makeDoc({ sensitive: true, sensitiveByName: null, sensitiveByUserId: null });
    const out = formatters.formatFullDocState({ ...doc, sections: [] }, [], []);
    // Provenance can be absent (an unattributed write). The warning must still
    // fire — degrading to silence here would lose the signal exactly when
    // attribution already failed.
    expect(out).toContain("⚠");
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
  });

  it("ac-13: the copy lives in the Scaffold and the formatter only consumes it", () => {
    tagAc(AC(13));
    const here = dirname(fileURLToPath(import.meta.url));
    const fmt = readFileSync(resolve(here, "..", "formatting", "formatters.ts"), "utf-8");
    const scaffold = readFileSync(
      resolve(here, "..", "..", "..", "shared", "src", "scaffold-data.ts"),
      "utf-8",
    );

    // std-15: agent-facing prose has one home, and it is not this formatter.
    expect(scaffold).toMatch(/SENSITIVE_WARNING_PROSE/);
    expect(fmt).toMatch(/SENSITIVE_WARNING_PROSE/);
  });

  it("ac-11: the block cannot reach a terse read — every body render is verbose-gated", () => {
    tagAc(AC(11));
    // "Not on terse reads" (dec-3) needed no flag of its own, but the reason is
    // one level up from where you would first look: `formatFullDocState` is
    // reached through the `formatState` helper, and the `ctx.verbose` branch sits
    // at each HANDLER that calls it — not beside the render. So the honest guard
    // is over every call site, not one of them.
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = resolve(here, "..", "agent", "handlers");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

    const ungated: string[] = [];
    for (const file of files) {
      const lines = readFileSync(resolve(dir, file), "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("formatState(")) return;
        if (line.includes("function") || line.includes("import")) return;
        const before = lines.slice(Math.max(0, i - 14), i).join("\n");
        if (!before.includes("verbose")) ungated.push(`${file}:${i + 1}`);
      });
    }

    expect(
      ungated,
      `These render the full doc body with no verbose guard above them, so the ` +
        `sensitivity block would reach a TERSE read — which dec-3 rules out:\n  ${ungated.join("\n  ")}`,
    ).toEqual([]);
  });
});

// ── spec-535 dec-7: the warning asks for something its reader can do ───────
//
// issue-4, the first field report after ship: an agent SAW the block, understood
// it, relayed it upward — then coded anyway, discharging the obligation with an
// argument it later called circular. dec-3 had designed against the spec-240
// failure (a warning skimmed past); that is not what happened, so louder copy
// was never the fix.
//
// The defect was that "Contact X before you change anything here" is
// unsatisfiable by a reader with no channel to X. These tests pin the three
// properties dec-7 requires, deliberately as PROPERTIES rather than exact
// strings — the wording may still improve, the contract may not silently rot.
describe("spec-535 dec-7: the warning is actionable and bounded", () => {
  const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;

  const block = (name: string | null = "Robin") =>
    formatters
      .formatFullDocState(
        { ...makeDoc({ sensitive: true, sensitiveByName: name, sensitiveByUserId: "u-1" }), sections: [] },
        [],
        [],
      )
      .split("\n")
      .filter((l) => l.includes("⚠"))
      .join("\n");

  it("ac-22: it asks the reader to stop and ask their operator — an action they can perform", () => {
    tagAc(AC(22));
    const out = block().toLowerCase();

    // The reachable action. An agent has no channel to a named human; its only
    // available compliance is to stop and ask whoever is driving it.
    expect(out).toMatch(/stop and ask/);
    expect(out).toMatch(/person you are working with/);
  });

  it("ac-22: the named contact is someone to RELAY to, not an instruction to reach them", () => {
    tagAc(AC(22));
    const out = block("Robin");

    expect(out).toContain("Robin");
    // The name must arrive attached to the relay, not standing alone as the
    // whole instruction — "tell them to contact Robin", never just "contact Robin".
    expect(out.toLowerCase()).toMatch(/tell them to contact robin/);
  });

  it("ac-23: it names the trigger and the discharge, leaving no scope undefined", () => {
    tagAc(AC(23));
    const out = block().toLowerCase();

    // WHEN it fires — the first change, not every edit.
    expect(out).toMatch(/first change/);
    // WHAT ends it. An undefined discharge is what let the reporting agent
    // resolve the question in its own favour.
    expect(out).toMatch(/one confirmation|covers this session/);
  });

  it("ac-24: it still says it blocks nothing, and stays portable", () => {
    tagAc(AC(24));
    const out = block();

    // ac-3's promise has to survive the rewording — a stricter-sounding ask
    // makes it MORE important to say the flag refuses nothing.
    expect(out.toLowerCase()).toMatch(/blocks nothing/);
    // std-22 — renders against arbitrary codebases.
    expect(out).not.toMatch(/packages\/|src\//);
    expect(out).not.toMatch(/\bstd-\d+\b/);
  });

  it("ac-23: with no recorded contact it still names the trigger and the discharge", () => {
    tagAc(AC(23));
    const out = block(null).toLowerCase();

    expect(out).toMatch(/stop and ask/);
    expect(out).toMatch(/first change/);
    expect(out).toMatch(/one confirmation|covers this session/);
    // Must not name nobody as if it were somebody.
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
    // std-1: "team" is banned in user-visible copy; the house noun is "org".
    expect(out).not.toMatch(/\bteam\b/);
  });
});
