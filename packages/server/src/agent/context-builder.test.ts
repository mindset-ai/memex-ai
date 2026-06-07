import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the import of the module under test. Each
// service module is replaced with a vi.fn() so each test can hand back a
// shaped fixture without touching the DB.
vi.mock("../services/documents.js", () => ({
  getDoc: vi.fn(),
}));
vi.mock("../services/decisions.js", () => ({
  listDecisions: vi.fn(),
}));
vi.mock("../services/tasks.js", () => ({
  listTasks: vi.fn(),
}));
vi.mock("../services/comments.js", () => ({
  reviewDocComments: vi.fn(),
}));
// Only the DB-touching `memexSlugsById` is mocked. `buildDocRef` and
// `buildChildRef` are pure functions over slugs + row data; keeping them
// real means tests assert the same canonical-ref strings the agent sees.
vi.mock("../mcp/refs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/refs.js")>();
  return {
    ...actual,
    memexSlugsById: vi.fn(),
  };
});

import { buildDocumentContext } from "./context-builder.js";
import { getDoc } from "../services/documents.js";
import { listDecisions } from "../services/decisions.js";
import { listTasks } from "../services/tasks.js";
import { reviewDocComments } from "../services/comments.js";
import { memexSlugsById } from "../mcp/refs.js";

// Stable test fixture — the canonical-ref shape the agent struggled with
// in production. Slugs + handle land in the context as
// `mindset-prod/memex-building-itself/specs/spec-68`.
const SLUGS = { namespace: "mindset-prod", memex: "memex-building-itself" };
const DOC_REF = "mindset-prod/memex-building-itself/specs/spec-68";

function makeDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "04e96013-3ea6-4c29-90a3-8f0d0ae236dc",
    memexId: "mx-uuid",
    handle: "spec-68",
    docType: "spec",
    title: "Scaffold — surface the agent's prompting",
    status: "build",
    sections: [
      {
        id: "912572bc-70d2-437e-9a38-89ec8d53397f",
        docId: "04e96013-3ea6-4c29-90a3-8f0d0ae236dc",
        sectionType: "overview",
        title: "Overview",
        content: "Problem statement goes here.",
        seq: 1,
      },
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        docId: "04e96013-3ea6-4c29-90a3-8f0d0ae236dc",
        sectionType: "ac",
        title: "Acceptance criteria",
        content: "Done when…",
        seq: 2,
      },
    ],
    creator: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getDoc).mockReset();
  vi.mocked(listDecisions).mockReset();
  vi.mocked(listTasks).mockReset();
  vi.mocked(reviewDocComments).mockReset();
  vi.mocked(memexSlugsById).mockReset();

  // Sensible defaults — tests override what they need.
  vi.mocked(memexSlugsById).mockResolvedValue(SLUGS);
  vi.mocked(getDoc).mockResolvedValue(makeDoc() as never);
  vi.mocked(listDecisions).mockResolvedValue([]);
  vi.mocked(listTasks).mockResolvedValue([]);
  vi.mocked(reviewDocComments).mockResolvedValue({ sections: [], decisions: [], tasks: [] });
});

describe("buildDocumentContext — canonical refs", () => {
  it("emits the doc canonical ref on the header", async () => {
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).toContain(`Ref: ${DOC_REF}`);
  });

  it("emits a ## Refs block listing every section ref in canonical form", async () => {
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).toContain("## Refs");
    expect(context).toContain(`${DOC_REF}/sections/s-1`);
    expect(context).toContain(`${DOC_REF}/sections/s-2`);
  });

  it("emits decision refs in the ## Refs block", async () => {
    vi.mocked(listDecisions).mockResolvedValue([
      {
        id: "dec-uuid-1",
        memexId: "mx-uuid",
        docId: "04e96013-3ea6-4c29-90a3-8f0d0ae236dc",
        seq: 1,
        title: "Scope and granularity",
        status: "open",
        context: null,
        resolution: null,
      } as never,
    ]);
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).toContain(`${DOC_REF}/decisions/dec-1`);
  });

  it("emits task refs in the ## Refs block", async () => {
    vi.mocked(listTasks).mockResolvedValue([
      {
        id: "task-uuid-1",
        memexId: "mx-uuid",
        docId: "04e96013-3ea6-4c29-90a3-8f0d0ae236dc",
        seq: 3,
        title: "Wire up the scaffold loader",
        status: "open",
        blocked: false,
        description: null,
        blockedByDecisions: [],
        blockedByTasks: [],
      } as never,
    ]);
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).toContain(`${DOC_REF}/tasks/t-3`);
  });

  it("uses s-N section headings, not 'Section N (id: uuid)'", async () => {
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).toContain("### s-1: Overview");
    expect(context).toContain("### s-2: Acceptance criteria");
    expect(context).not.toMatch(/^### Section \d+:/m);
  });
});

describe("buildDocumentContext — no UUIDs in agent-facing output", () => {
  // The MCP boundary rejects UUIDs (`assertRefNotUuid`); the agent's
  // mutation-protocol skill tells it the same. Showing UUIDs in the
  // Document Context contradicts both, which is exactly the loop the
  // user hit in production (section UUID → invalid handle error).
  it("does not leak the doc UUID", async () => {
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).not.toContain("04e96013-3ea6-4c29-90a3-8f0d0ae236dc");
  });

  it("does not leak section UUIDs", async () => {
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).not.toContain("912572bc-70d2-437e-9a38-89ec8d53397f");
    expect(context).not.toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("does not leak decision UUIDs", async () => {
    vi.mocked(listDecisions).mockResolvedValue([
      {
        id: "ffffffff-1111-2222-3333-444444444444",
        memexId: "mx-uuid",
        docId: "04e96013-3ea6-4c29-90a3-8f0d0ae236dc",
        seq: 1,
        title: "Scope",
        status: "open",
        context: null,
        resolution: null,
      } as never,
    ]);
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).not.toContain("ffffffff-1111-2222-3333-444444444444");
  });

  it("does not leak task UUIDs", async () => {
    vi.mocked(listTasks).mockResolvedValue([
      {
        id: "11111111-2222-3333-4444-555555555555",
        memexId: "mx-uuid",
        docId: "04e96013-3ea6-4c29-90a3-8f0d0ae236dc",
        seq: 1,
        title: "Do thing",
        status: "open",
        blocked: false,
        description: null,
        blockedByDecisions: [],
        blockedByTasks: [],
      } as never,
    ]);
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).not.toContain("11111111-2222-3333-4444-555555555555");
  });

  it("does not leak comment UUIDs", async () => {
    vi.mocked(reviewDocComments).mockResolvedValue({
      sections: [
        {
          section: {
            id: "912572bc-70d2-437e-9a38-89ec8d53397f",
            docId: "04e96013-3ea6-4c29-90a3-8f0d0ae236dc",
            sectionType: "overview",
            title: "Overview",
            content: "x",
            seq: 1,
          } as never,
          comments: [
            {
              id: "cccccccc-dddd-eeee-ffff-000000000000",
              seq: 4,
              content: "Tighten this paragraph",
              authorName: "wic",
            } as never,
          ],
        },
      ],
      decisions: [],
      tasks: [],
    });
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).not.toContain("cccccccc-dddd-eeee-ffff-000000000000");
    expect(context).toContain("c-4");
  });
});

describe("buildDocumentContext — phase mapping (preserved)", () => {
  it("maps Spec 'build' status to the build phase", async () => {
    vi.mocked(getDoc).mockResolvedValue(makeDoc({ status: "build" }) as never);
    const { phase } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(phase).toBe("build");
  });

  it("maps Spec 'draft' status to draft", async () => {
    vi.mocked(getDoc).mockResolvedValue(makeDoc({ status: "draft" }) as never);
    const { phase } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(phase).toBe("draft");
  });

  it("falls back to specify for unknown statuses", async () => {
    vi.mocked(getDoc).mockResolvedValue(makeDoc({ status: "wildcard" }) as never);
    const { phase } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(phase).toBe("specify");
  });
});

describe("buildDocumentContext — empty children are omitted, not noisy", () => {
  it("omits the Decisions sub-list when there are no decisions", async () => {
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).not.toMatch(/^Decisions:/m);
  });

  it("omits the Tasks sub-list when there are no tasks", async () => {
    const { context } = await buildDocumentContext("mx-uuid", "doc-id");
    expect(context).not.toMatch(/^Tasks:/m);
  });
});
