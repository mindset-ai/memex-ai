// spec-143 t-4 (dec-6): unit tests for buildDriftContext — the drift agent's
// context builder. It summarizes the OPEN drift across a Memex's Standards,
// grouped by Standard, by reusing listDriftInbox. We mock listDriftInbox so the
// summary shape is asserted without touching the DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

vi.mock("../services/drift-inbox.js", () => ({
  listDriftInbox: vi.fn(),
}));

// buildDriftContext now looks up the memex slugs to build a canonical Standard
// ref per group; mock the helper so the test stays DB-free.
vi.mock("../mcp/refs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/refs.js")>();
  return {
    ...actual,
    memexSlugsById: vi
      .fn()
      .mockResolvedValue({ namespace: "mindset-prod", memex: "memex-building-itself" }),
  };
});

import { buildDriftContext } from "./context-builder.js";
import { listDriftInbox } from "../services/drift-inbox.js";
import type { DriftInboxRow, DriftInboxPage } from "../services/drift-inbox.js";

// spec-143 t-4 (dec-6): the in-UI drift agent runs in a drift mode with
// drift-specific context + tools.
const AC_DRIFT_MODE =
  "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-12";

function row(overrides: Partial<DriftInboxRow> = {}): DriftInboxRow {
  return {
    commentId: "c-1",
    commentHandle: "c-1",
    commentType: "drift",
    source: "agent",
    authorName: "Agent",
    content: "Repo no longer does X.",
    proposedContent: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    section: { id: "s-1", sectionType: "do", title: null, content: "Always X." },
    doc: {
      id: "d-1",
      handle: "std-1",
      title: "Naming",
      docType: "standard",
      status: "build",
    },
    ...overrides,
  };
}

function page(items: DriftInboxRow[]): DriftInboxPage {
  return { items, nextCursor: null };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildDriftContext", () => {
  it("summarizes open drift grouped by standard, counting observations vs proposals", async () => {
    tagAc(AC_DRIFT_MODE);
    vi.mocked(listDriftInbox).mockResolvedValueOnce(
      page([
        // std-1: 1 observation + 1 proposal
        row({
          commentId: "a",
          commentHandle: "c-2",
          commentType: "drift",
          content: "The auth module no longer enforces the X invariant.",
        }),
        row({
          commentId: "b",
          commentHandle: "c-3",
          commentType: "plan_revision",
          content: "Reword the rule to allow Y.",
          proposedContent: "Always Y, never X.",
        }),
        // std-9: 1 observation, different standard + title
        row({
          commentId: "c",
          commentType: "drift",
          content: "Infra topology drifted from the documented one.",
          doc: {
            id: "d-2",
            handle: "std-9",
            title: "Infrastructure",
            docType: "standard",
            status: "build",
          },
        }),
      ]),
    );

    const result = await buildDriftContext("mx-uuid");

    expect(result.phase).toBe("plan");
    // Headline count: 3 items across 2 standards.
    expect(result.context).toContain("Open drift: 3 items across 2 standards.");
    // Per-standard group headers (handle + title + counts).
    expect(result.context).toContain('## std-1 "Naming" — 1 observation, 1 proposal');
    expect(result.context).toContain('## std-9 "Infrastructure" — 1 observation');
    // A canonical Standard ref is offered per group so the agent can act.
    expect(result.context).toContain(
      "Standard ref: mindset-prod/memex-building-itself/standards/std-1",
    );
    // The ACTUAL observation / proposal BODY text is present (not just counts),
    // each line led by the item's c-N ref (spec-143 i-2) so the agent can act
    // on it directly — no list_comments recovery round-trip.
    expect(result.context).toContain(
      "OBSERVATION c-2 by Agent: The auth module no longer enforces the X invariant.",
    );
    expect(result.context).toContain(
      "PROPOSAL c-3 by Agent: Reword the rule to allow Y.",
    );
    // The proposed replacement ("after") for the proposal is included.
    expect(result.context).toContain("Proposed new rule: Always Y, never X.");
    // The section's CURRENT rule ("before") is shown once per standard.
    expect(result.context).toContain("Current rule");
    expect(result.context).toContain("Always X.");
    // The closing note tells the agent the c-N refs are inline and how to act.
    expect(result.context).toContain("update_comment");
    expect(result.context).toContain("update_section");
    // listDriftInbox is read with the service hard-cap limit.
    expect(listDriftInbox).toHaveBeenCalledWith("mx-uuid", { limit: 200 });
  });

  it("pluralizes correctly for a single item on a single standard", async () => {
    tagAc(AC_DRIFT_MODE);
    vi.mocked(listDriftInbox).mockResolvedValueOnce(
      page([
        row({
          commentId: "a",
          commentType: "plan_revision",
          content: "Tighten the wording.",
          proposedContent: "x",
        }),
      ]),
    );

    const result = await buildDriftContext("mx-uuid");
    expect(result.context).toContain("Open drift: 1 item across 1 standard.");
    expect(result.context).toContain('## std-1 "Naming" — 1 proposal');
    expect(result.context).toContain("PROPOSAL c-1 by Agent: Tighten the wording.");
    expect(result.context).toContain("Proposed new rule: x");
  });

  it("truncates a long observation body to keep the context bounded", async () => {
    tagAc(AC_DRIFT_MODE);
    const longBody = "Z".repeat(800);
    vi.mocked(listDriftInbox).mockResolvedValueOnce(
      page([row({ commentId: "a", commentType: "drift", content: longBody })]),
    );

    const result = await buildDriftContext("mx-uuid");
    // Ellipsis present, and the full 800-char body is NOT echoed verbatim.
    expect(result.context).toContain("…");
    expect(result.context).not.toContain(longBody);
  });

  it("returns an explicit 'no open drift' context when the inbox is empty", async () => {
    tagAc(AC_DRIFT_MODE);
    vi.mocked(listDriftInbox).mockResolvedValueOnce(page([]));

    const result = await buildDriftContext("mx-uuid");
    expect(result.phase).toBe("plan");
    expect(result.context).toContain("Open drift: none.");
    // Must not claim a phantom count.
    expect(result.context).not.toContain("across");
  });
});
