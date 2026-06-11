import { describe, it, expect, vi, beforeEach } from "vitest";
import { testMutate } from "../services/__test__/mutate-helpers.js";

// Hoisted so vi.mock factories below can reference them — vi.mock runs before the
// module body, so plain `const` would be hit during the TDZ.
const {
  TEST_USER_ID,
  TEST_MEMEX_ID,
  TEST_DOC_ID,
  TEST_SECTION_ID,
  TEST_DECISION_ID,
  TEST_TASK_ID,
  TEST_COMMENT_ID,
  TEST_NS_ID,
} = vi.hoisted(() => ({
  TEST_USER_ID: "00000000-0000-0000-0000-00000000beef",
  TEST_MEMEX_ID: "00000000-0000-0000-0000-00000000face",
  TEST_DOC_ID: "00000000-0000-0000-0000-00000000d0c1",
  TEST_SECTION_ID: "00000000-0000-0000-0000-000000005ec1",
  TEST_DECISION_ID: "00000000-0000-0000-0000-00000000dec1",
  TEST_TASK_ID: "00000000-0000-0000-0000-00000000ta51",
  TEST_COMMENT_ID: "00000000-0000-0000-0000-00000000c0c1",
  TEST_NS_ID: "00000000-0000-0000-0000-0000000000ff",
}));

// Canonical refs the tests pass in place of the old UUID args. b-36 D-7
// rejected UUID inputs on the MCP boundary; tests must compose refs from the
// (namespace, memex, docType, handle) tuple. b-105 renamed Brief → Spec; the
// canonical doc-type segment is now `specs` and the handle prefix `spec-`.
const TEST_NS_SLUG = "test";
const TEST_MEMEX_SLUG = "main";
const TEST_DOC_HANDLE = "spec-1";
const TEST_DOC_REF = `${TEST_NS_SLUG}/${TEST_MEMEX_SLUG}/specs/${TEST_DOC_HANDLE}`;
const TEST_SECTION_REF = `${TEST_DOC_REF}/sections/s-1`;
const TEST_DECISION_REF = `${TEST_DOC_REF}/decisions/dec-1`;
const TEST_TASK_REF = `${TEST_DOC_REF}/tasks/t-1`;
const TEST_COMMENT_REF = `${TEST_DOC_REF}/comments/c-1`;

const baseDate = new Date("2026-03-25T12:00:00Z");

const DOC_ROW = {
  id: TEST_DOC_ID,
  memexId: TEST_MEMEX_ID,
  handle: TEST_DOC_HANDLE,
  title: "Test Doc",
  docType: "spec", // DB enum value (specs/docs/standards/execution-plans → spec/document/standard/execution_plan)
  status: "draft",
  parentDocId: null,
  createdByUserId: null,
  createdAt: baseDate,
  statusChangedAt: baseDate,
  archivedAt: null,
  pausedAt: null,
  narrativeLastConsolidatedAt: null,
  isDemo: false,
};
const SECTION_ROW = {
  id: TEST_SECTION_ID,
  memexId: TEST_MEMEX_ID,
  docId: TEST_DOC_ID,
  sectionType: "purpose",
  title: "Purpose",
  description: null,
  content: "Some content",
  seq: 1,
  preamble: null,
  position: 1,
  status: "active",
  previousStatus: null,
  createdAt: baseDate,
  updatedAt: baseDate,
  actorUserId: null,
  actorName: null,
  channel: null,
};
const DECISION_ROW = {
  id: TEST_DECISION_ID,
  memexId: TEST_MEMEX_ID,
  docId: TEST_DOC_ID,
  seq: 1,
  title: "A decision",
  status: "open",
};
const TASK_ROW = {
  id: TEST_TASK_ID,
  memexId: TEST_MEMEX_ID,
  docId: TEST_DOC_ID,
  seq: 1,
  title: "A task",
  description: "x",
  status: "not_started",
};
const COMMENT_ROW = {
  id: TEST_COMMENT_ID,
  memexId: TEST_MEMEX_ID,
  docId: TEST_DOC_ID,
  seq: 1,
  sectionId: TEST_SECTION_ID,
  decisionId: null,
  taskId: null,
};

// spec-161: standard + clause fixtures for the clause-tool guard tests.
const STD_DOC_ID = "00000000-0000-0000-0000-0000000000d5";
const TEST_CLAUSE_ID = "00000000-0000-0000-0000-0000000000c1";
const STANDARD_DOC_REF = `${TEST_NS_SLUG}/${TEST_MEMEX_SLUG}/standards/std-1`;
const STANDARD_SECTION_REF = `${STANDARD_DOC_REF}/sections/s-1`;
const CLAUSE_REF = `${STANDARD_DOC_REF}/clauses/cl-1`;
const STANDARD_DOC_ROW = { ...DOC_ROW, id: STD_DOC_ID, handle: "std-1", docType: "standard" };
const STANDARD_SECTION_ROW = {
  ...SECTION_ROW,
  docId: STD_DOC_ID,
  sectionType: "rule",
  title: "Rule",
};
const CLAUSE_ROW = {
  id: TEST_CLAUSE_ID,
  memexId: TEST_MEMEX_ID,
  docId: STD_DOC_ID,
  sectionId: TEST_SECTION_ID,
  seq: 1,
  position: 1,
  body: "A clause.",
  status: "active",
  previousStatus: null,
  createdAt: baseDate,
  updatedAt: baseDate,
};

// b-36 T-6: the MCP adapter calls `resolveCanonicalRef` (services/resolver.js)
// and then `assertMembershipForMemex` (auth.js). Mock both so the tool tests
// can run without a real DB. The mock decodes the ref by suffix so tests can
// drive each entity-kind path without rebuilding the resolver.
vi.mock("../services/resolver.js", () => ({
  resolveRef: vi.fn(async (input: string | { docType: string; child?: { type: string } }) => {
    // We're called with a ParsedRef object (after the `parseRef` step in
    // tools.ts) — pick the kind from the child or doc.
    const parsed = input as { docType?: string; child?: { type: string } };
    const childType = parsed.child?.type;
    if (childType === "sections") {
      // spec-161: a section under a standards/ doc carries a standard parent so the
      // clause-tool / update_section doc-type guards can be exercised both ways.
      const isStd = parsed.docType === "standards";
      return {
        found: true,
        entity: {
          kind: "section",
          row: isStd ? STANDARD_SECTION_ROW : SECTION_ROW,
          doc: isStd ? STANDARD_DOC_ROW : DOC_ROW,
        },
      };
    }
    if (childType === "clauses") {
      return { found: true, entity: { kind: "clause", row: CLAUSE_ROW, doc: STANDARD_DOC_ROW } };
    }
    if (childType === "decisions") {
      return { found: true, entity: { kind: "decision", row: DECISION_ROW, doc: DOC_ROW } };
    }
    if (childType === "tasks") {
      return { found: true, entity: { kind: "task", row: TASK_ROW, doc: DOC_ROW } };
    }
    if (childType === "comments") {
      return { found: true, entity: { kind: "comment", row: COMMENT_ROW, doc: DOC_ROW } };
    }
    // Default: doc-level ref. Use the URL doc-type to derive the entity kind.
    const docType = parsed.docType ?? "specs";
    const kindMap: Record<string, string> = {
      specs: "spec",
      docs: "doc",
      standards: "standard",
      "execution-plans": "execution-plan",
    };
    const kind = kindMap[docType] ?? "spec";
    return { found: true, entity: { kind, row: DOC_ROW } };
  }),
}));

// All membership / workspace resolution is short-circuited so the tool tests focus on
// service-call wiring.
vi.mock("./auth.js", () => ({
  McpAuthError: class McpAuthError extends Error {},
  // spec-111 t-4: the read message constant the dispatch wrapper imports.
  READ_ONLY_PUBLIC_MESSAGE: "Public Memexes are read-only for non-members",
  isUuid: () => true,
  resolveWorkspace: vi.fn().mockResolvedValue(TEST_MEMEX_ID),
  resolveMemexFromEntity: vi.fn().mockResolvedValue(TEST_MEMEX_ID),
  resolveMemexFromDocRef: vi.fn().mockResolvedValue(TEST_MEMEX_ID),
  assertMembership: vi.fn().mockResolvedValue(undefined),
  assertMembershipForMemex: vi.fn().mockResolvedValue(undefined),
  // spec-111 t-4: read-gated resolvers used by the dispatch wrapper. Default to
  // a writeable member (readOnly: false) so the existing wiring tests focus on
  // service-call routing; the read-only gating itself is covered end-to-end in
  // tools.readonly.integration.test.ts.
  resolveWorkspaceForRead: vi
    .fn()
    .mockResolvedValue({ memexId: TEST_MEMEX_ID, readOnly: false }),
  resolveMemexFromEntityForRead: vi
    .fn()
    .mockResolvedValue({ memexId: TEST_MEMEX_ID, readOnly: false }),
  assertReadAccessForMemex: vi.fn().mockResolvedValue({ readOnly: false }),
}));

// workspaceUrl in tools.ts calls memexSlugsById from ./refs.js to build the
// path-based tenant URL; mock it so we don't hit the database.
vi.mock("./refs.js", async () => {
  const actual = await vi.importActual<typeof import("./refs.js")>("./refs.js");
  return {
    ...actual,
    memexSlugsById: vi.fn().mockResolvedValue({ namespace: "test", memex: "main" }),
  };
});

vi.mock("../services/memexes.js", () => ({
  getMemexById: vi.fn().mockResolvedValue({
    id: TEST_MEMEX_ID,
    name: "Test",
    namespaceId: TEST_NS_ID,
    slug: "main",
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  getOrgIdForMemex: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/users.js", () => ({
  listMemberships: vi.fn().mockResolvedValue([
    {
      memexId: TEST_MEMEX_ID,
      slug: "test",
      memexSlug: "main",
      name: "Test",
      kind: "team",
      role: "administrator",
    },
  ]),
}));

vi.mock("../services/documents.js", () => ({
  createDocDraft: vi.fn(),
  listDocs: vi.fn(),
  getDoc: vi.fn(),
  updateDocStatus: vi.fn(),
  updateDocTitle: vi.fn(),
  promoteToSpec: vi.fn(),
  DOC_STATUSES: ["draft", "review", "implementation", "done"] as const,
}));

vi.mock("../services/sections.js", async (importOriginal) => {
  // Keep the pure helpers real (e.g. resolveSectionWriteMode, the spec-161 doc-type
  // gate); only the DB-touching writers are stubbed.
  const actual = await importOriginal<typeof import("../services/sections.js")>();
  return {
    ...actual,
    addSection: vi.fn(),
    updateSection: vi.fn(),
  };
});

vi.mock("../services/clauses.js", () => ({
  createClause: vi.fn(),
  updateClause: vi.fn(),
  deleteClause: vi.fn(),
  addClausesToSection: vi.fn(),
}));

vi.mock("../services/comments.js", () => ({
  addComment: vi.fn(),
  addDecisionComment: vi.fn(),
  addTaskComment: vi.fn(),
  listComments: vi.fn(),
  listDecisionComments: vi.fn(),
  listTaskComments: vi.fn(),
  listCommentsForDoc: vi.fn().mockResolvedValue({ sections: [], decisions: [], tasks: [] }),
  reviewDocComments: vi.fn(),
  resolveComment: vi.fn(),
  getDocForTarget: vi.fn(),
  getDocForComment: vi.fn(),
}));

vi.mock("../services/decisions.js", () => ({
  createDecision: vi.fn(),
  listDecisions: vi.fn().mockResolvedValue([]),
  getDecision: vi.fn(),
  resolveDecision: vi.fn(),
  reopenDecision: vi.fn(),
  proposeDecision: vi.fn(),
  approveDecision: vi.fn(),
  rejectDecision: vi.fn(),
}));

vi.mock("../services/tasks.js", () => ({
  createTask: vi.fn(),
  listTasks: vi.fn().mockResolvedValue([]),
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  getReadyTasks: vi.fn(),
}));

import { createMcpServer, MEMEX_AGENT_INSTRUCTIONS } from "./tools.js";
import {
  createDocDraft,
  listDocs,
  getDoc,
  updateDocStatus,
  updateDocTitle,
} from "../services/documents.js";
import { addSection, updateSection } from "../services/sections.js";
import { createClause, updateClause, deleteClause } from "../services/clauses.js";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC161_AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-161/acs/ac-${n}`;
import {
  listCommentsForDoc,
  reviewDocComments,
} from "../services/comments.js";
import { NotFoundError } from "../types/errors.js";
import { listMemberships } from "../services/users.js";
import { resolveWorkspaceForRead } from "./auth.js";

function makeDoc(overrides = {}) {
  return {
    ...DOC_ROW,
    creator: null,
    ...overrides,
  };
}

function makeSection(overrides = {}) {
  return {
    ...SECTION_ROW,
    ...overrides,
  };
}

describe("MCP Server registration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers all expected tools (doc-14 catalogue)", () => {
    const server = createMcpServer(TEST_USER_ID);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const toolNames = Object.keys(tools);

    // Core CRUD set per the doc-14 32-tool catalogue.
    expect(toolNames).toContain("list_memexes");
    expect(toolNames).toContain("create_doc");
    expect(toolNames).toContain("list_docs");
    expect(toolNames).toContain("get_doc");
    expect(toolNames).toContain("update_doc");
    expect(toolNames).toContain("update_section");
    expect(toolNames).toContain("add_section");
    expect(toolNames).toContain("add_comment");
    expect(toolNames).toContain("list_comments");
    expect(toolNames).toContain("update_comment");
    expect(toolNames).toContain("update_task");
    expect(toolNames).toContain("delete_task");
  });

  it("registers a stable, non-empty tool surface with no duplicate names", () => {
    // Asserting on the EXACT count is brittle — every new MCP tool slice (t-9, t-10,
    // t-13, t-17, …) bumps it and the test churns. Instead pin the invariants that
    // actually matter for the surface contract: a non-empty registry, no duplicates,
    // and the named-coverage assertion in the prior test guarantees the *important*
    // tools are present. If a count assertion is needed for change review, run
    // `Object.keys(tools).length` locally and compare against the diff.
    const server = createMcpServer(TEST_USER_ID);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("does NOT register old/renamed tool names", () => {
    const server = createMcpServer(TEST_USER_ID);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const toolNames = Object.keys(tools);

    // `publish_doc` was a tentative pre-doc-10 name; the real surface uses
    // `publish_spec` / `update_doc_status` (per t-6 doc-10 Slice 1, renamed
    // from `publish_brief` in b-105).
    expect(toolNames).not.toContain("publish_doc");
    expect(toolNames).not.toContain("update_strategy_status");
    // Strategy → Mission → Brief → Spec rename: every legacy verb is gone.
    expect(toolNames).not.toContain("list_strategies");
    expect(toolNames).not.toContain("get_strategy_draft");
    expect(toolNames).not.toContain("get_strategy_status");
    expect(toolNames).not.toContain("create_strategy_draft");
    expect(toolNames).not.toContain("update_strategy_draft");
    expect(toolNames).not.toContain("publish_strategy");
    // b-105: legacy `publish_brief` / `assess_brief` names should also be gone.
    expect(toolNames).not.toContain("publish_brief");
    expect(toolNames).not.toContain("assess_brief");
  });

  // doc-27 t-2: MCP instructions must carry the code-grounding directive so the
  // agent sees it on first connect. Asserted as substrings rather than the
  // full sentence so the surrounding prose can be re-worded for length without
  // breaking the test — change the substrings only when the directive's
  // semantic meaning changes (e.g. if "code-touching decision" gets re-named).
  it("MEMEX_AGENT_INSTRUCTIONS contains the code-grounding directive", () => {
    expect(MEMEX_AGENT_INSTRUCTIONS).toContain(
      "Read the source a code-touching decision names before resolving it",
    );
    expect(MEMEX_AGENT_INSTRUCTIONS).toContain("don't lean on CLAUDE.md");
  });

  // t-3: description must surface the (docId, sectionType) uniqueness constraint
  // and give the agent at least one example identifier to pick on first attempt.
  it("add_section description surfaces the uniqueness constraint and example identifiers", () => {
    const server = createMcpServer(TEST_USER_ID);
    const tools = (
      server as unknown as { _registeredTools: Record<string, { description?: string }> }
    )._registeredTools;
    const description = tools.add_section?.description ?? "";

    expect(description).toMatch(/unique/i);
    expect(description).toMatch(/sectionType|section_type|section identifier/i);
    // At least one of the suggested concrete identifiers should appear so the
    // agent has a concrete example to copy.
    expect(description).toMatch(/design|architecture|testing|risks|issue-1|risk-/);
  });
});

describe("MCP Tool handlers via HTTP", () => {
  beforeEach(() => vi.clearAllMocks());

  async function mcpCall(toolName: string, args: Record<string, unknown> = {}) {
    const { Hono } = await import("hono");
    const { cors } = await import("hono/cors");
    const { WebStandardStreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );

    const testApp = new Hono();
    testApp.use("*", cors());
    testApp.all("/mcp", async (c) => {
      const mcpServer = createMcpServer(TEST_USER_ID);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcpServer.connect(transport);
      return transport.handleRequest(c.req.raw);
    });

    // Per dec-1 of doc-20 the MCP surface defaults to terse output. Pre-doc-20
    // assertions here pattern-match on the verbose markdown surface, so opt in
    // via the documented `verbose: true` escape hatch unless the test sets it.
    const argsWithVerbose =
      "verbose" in args ? args : { ...args, verbose: true };
    const res = await testApp.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: argsWithVerbose },
      }),
    });

    const text = await res.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error(`No data in response: ${text}`);
    return JSON.parse(dataLine.slice(6));
  }

  it("list_memexes returns the user's memberships", async () => {
    const response = await mcpCall("list_memexes", {});
    const text = response.result.content[0].text;

    expect(listMemberships).toHaveBeenCalledWith(TEST_USER_ID);
    expect(text).toContain("test");
    expect(text).toContain("administrator");
  });

  it("create_doc resolves workspace then calls service", async () => {
    vi.mocked(createDocDraft).mockResolvedValue(testMutate({ ...makeDoc(), sections: [makeSection()], decisions: [] }));
    vi.mocked(getDoc).mockResolvedValue({ ...makeDoc(), sections: [makeSection()] });

    const response = await mcpCall("create_doc", {
      title: "My Spec",
      purpose: "Define the API",
    });

    expect(resolveWorkspaceForRead).toHaveBeenCalledWith(TEST_USER_ID, undefined, undefined);
    expect(createDocDraft).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "My Spec",
      "Define the API",
      "spec",
      undefined,
      undefined,
      TEST_USER_ID,
      // spec-122 dec-2/dec-5: the create now threads the activity contract
      // (WHO + HOW) as the 8th arg so Pulse attributes the create to the human +
      // the MCP surface.
      { actorUserId: TEST_USER_ID, channel: "mcp" },
    );
    expect(response.result.content[0].text).toContain("Test Doc");
  });

  it("create_doc for a standard nudges toward the authoring-standards guidance", async () => {
    vi.mocked(createDocDraft).mockResolvedValue(
      testMutate({ ...makeDoc({ docType: "standard", handle: "std-1" }), sections: [], decisions: [] }),
    );

    const response = await mcpCall("create_doc", {
      title: "Smoke tests are mandatory",
      purpose: "why",
      docType: "standard",
      verbose: false, // the nudge rides the terse response (what real create_doc returns)
    });

    const text = response.result.content[0].text;
    expect(text).toContain("get_information(topic='authoring-standards')");
    expect(text).toMatch(/clauses/i); // points at the clause-first flow
  });

  it("create_doc passes through memex argument", async () => {
    vi.mocked(createDocDraft).mockResolvedValue(testMutate({ ...makeDoc(), sections: [makeSection()], decisions: [] }));
    vi.mocked(getDoc).mockResolvedValue({ ...makeDoc(), sections: [makeSection()] });

    await mcpCall("create_doc", { memex: "mindset", title: "X", purpose: "Y" });

    expect(resolveWorkspaceForRead).toHaveBeenCalledWith(TEST_USER_ID, "mindset", undefined);
  });

  it("list_docs requires memex via resolver", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await mcpCall("list_docs", { memex: "mindset" });

    expect(resolveWorkspaceForRead).toHaveBeenCalledWith(TEST_USER_ID, "mindset", undefined);
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: "spec",
      // spec-178 t-11 / dec-11 (ac-37): the MCP/agent enumeration path excludes
      // is_demo specs (the REST board path leaves it unset). Asserted here so the
      // exclusion can't silently regress off the agent surface.
      excludeDemo: true,
      includePaused: false,
      statusIn: ["specify", "build", "verify"],
    });
  });

  it("get_doc accepts a canonical ref and returns the doc state", async () => {
    vi.mocked(getDoc).mockResolvedValue({ ...makeDoc(), sections: [makeSection()] });

    const response = await mcpCall("get_doc", { ref: TEST_DOC_REF });
    const text = response.result.content[0].text;

    expect(text).toContain("Test Doc");
  });

  it("get_doc rejects a raw UUID with the canonical hard-error", async () => {
    // b-36 D-7: UUID inputs are no longer accepted on the MCP boundary.
    const response = await mcpCall("get_doc", { ref: TEST_DOC_ID });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain(
      "UUID inputs no longer accepted",
    );
  });

  it("update_doc({status}) updates and returns full state (replaces update_doc_status)", async () => {
    vi.mocked(updateDocStatus).mockResolvedValue(testMutate(makeDoc({ status: "review" })));
    vi.mocked(getDoc).mockResolvedValue({
      ...makeDoc({ status: "review" }),
      sections: [makeSection()],
    });

    const response = await mcpCall("update_doc", { ref: TEST_DOC_REF, status: "review" });

    expect(updateDocStatus).toHaveBeenCalledWith(TEST_MEMEX_ID, TEST_DOC_ID, "review", expect.anything());
    expect(response.result.content[0].text).toContain("[REVIEW]");
  });

  it("update_doc rejects invalid status before reaching handler", async () => {
    const response = await mcpCall("update_doc", { ref: TEST_DOC_REF, status: "active" });
    expect(response.error ?? response.result?.isError).toBeTruthy();
  });

  it("update_doc({title}) updates and returns full state (replaces update_doc_title)", async () => {
    vi.mocked(updateDocTitle).mockResolvedValue(testMutate(makeDoc({ title: "Renamed" })));
    vi.mocked(getDoc).mockResolvedValue({
      ...makeDoc({ title: "Renamed" }),
      sections: [makeSection()],
    });

    const response = await mcpCall("update_doc", { ref: TEST_DOC_REF, title: "Renamed" });

    expect(updateDocTitle).toHaveBeenCalledWith(TEST_MEMEX_ID, TEST_DOC_ID, "Renamed");
    expect(response.result.content[0].text).toContain("Renamed");
  });

  it("update_doc({title}) surfaces NotFoundError as MCP error", async () => {
    vi.mocked(updateDocTitle).mockRejectedValue(new NotFoundError("Document xyz not found"));

    const response = await mcpCall("update_doc", { ref: TEST_DOC_REF, title: "Hi" });

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("Not found");
  });

  it("add_section uses the doc ref", async () => {
    vi.mocked(addSection).mockResolvedValue(testMutate(makeSection()));
    vi.mocked(getDoc).mockResolvedValue({ ...makeDoc(), sections: [makeSection()] });

    await mcpCall("add_section", {
      ref: TEST_DOC_REF,
      sectionType: "risks",
      content: "Risk content",
    });

    expect(addSection).toHaveBeenCalledWith(TEST_MEMEX_ID, TEST_DOC_ID, "risks", "Risk content", undefined, undefined, expect.anything());
  });

  // spec-161 (ac-11): clause-grain tools are standards-only and cross-redirect.
  it("add_clause creates a clause on a standard section", async () => {
    tagAc(SPEC161_AC(11));
    vi.mocked(createClause).mockResolvedValue(testMutate({ ...CLAUSE_ROW, seq: 7 }));
    const res = await mcpCall("add_clause", { ref: STANDARD_SECTION_REF, body: "New clause.", verbose: false });
    expect(createClause).toHaveBeenCalledWith(TEST_MEMEX_ID, TEST_SECTION_ID, "New clause.", undefined);
    expect(res.result.content[0].text).toContain("cl-7");
  });

  it("add_clause on a non-standard section is rejected with a redirect", async () => {
    tagAc(SPEC161_AC(11));
    const res = await mcpCall("add_clause", { ref: TEST_SECTION_REF, body: "x" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/only standards have clauses/i);
  });

  it("edit_clause updates a clause by its cl-N ref", async () => {
    tagAc(SPEC161_AC(11));
    vi.mocked(updateClause).mockResolvedValue(testMutate({ ...CLAUSE_ROW, seq: 1 }));
    const res = await mcpCall("edit_clause", { ref: CLAUSE_REF, body: "Edited.", verbose: false });
    expect(updateClause).toHaveBeenCalledWith(TEST_MEMEX_ID, TEST_CLAUSE_ID, "Edited.");
    expect(res.result.content[0].text).toContain("cl-1");
  });

  it("edit_clause rejects a non-clause ref", async () => {
    tagAc(SPEC161_AC(11));
    const res = await mcpCall("edit_clause", { ref: STANDARD_SECTION_REF, body: "x" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/expects a clause ref/i);
  });

  it("delete_clause soft-deletes a clause by its cl-N ref", async () => {
    tagAc(SPEC161_AC(11));
    vi.mocked(deleteClause).mockResolvedValue(testMutate({ ...CLAUSE_ROW, seq: 1 }));
    const res = await mcpCall("delete_clause", { ref: CLAUSE_REF, verbose: false });
    expect(deleteClause).toHaveBeenCalledWith(TEST_MEMEX_ID, TEST_CLAUSE_ID);
    expect(res.result.content[0].text).toContain("cl-1");
  });

  it("update_section is blocked on a standard, redirecting to the clause tools", async () => {
    tagAc(SPEC161_AC(11));
    const res = await mcpCall("update_section", { ref: STANDARD_SECTION_REF, content: "x" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/clause grain/i);
  });

  it("update_section resolves the section via its ref", async () => {
    vi.mocked(updateSection).mockResolvedValue(testMutate(makeSection({ content: "Updated" })));
    vi.mocked(getDoc).mockResolvedValue({ ...makeDoc(), sections: [makeSection({ content: "Updated" })], creator: null });

    const response = await mcpCall("update_section", {
      ref: TEST_SECTION_REF,
      content: "Updated",
    });

    expect(updateSection).toHaveBeenCalledWith(TEST_MEMEX_ID, TEST_SECTION_ID, "Updated", {
      sectionType: undefined,
      description: undefined,
    }, expect.anything());
    expect(response.result.content[0].text).toContain("Updated");
  });

  it("list_comments with a doc ref returns the doc-scoped review (replaces list_doc_comments)", async () => {
    vi.mocked(getDoc).mockResolvedValue({ ...makeDoc(), sections: [], creator: null });

    const response = await mcpCall("list_comments", { ref: TEST_DOC_REF });

    // doc-14: list_comments({ref}) on a doc threads typed-comment options through. With no
    // `types` arg, we pass an empty options object.
    expect(listCommentsForDoc).toHaveBeenCalledWith(TEST_MEMEX_ID, TEST_DOC_ID, {});
    expect(response.result.content[0].text).toContain("Status: DRAFT");
  });

  it("list_comments({mode:'review'}) returns section content with open comments (replaces review_doc_comments)", async () => {
    vi.mocked(reviewDocComments).mockResolvedValue({
      sections: [
        {
          section: makeSection({ content: "Current section text" }),
          comments: [
            {
              id: "c1",
              memexId: TEST_MEMEX_ID,
              docId: TEST_DOC_ID,
              seq: 1,
              sectionId: TEST_SECTION_ID,
              decisionId: null,
              taskId: null,
              authorName: "Alice",
              authorUserId: null,
              authorNamespaceId: null,
              content: "Please expand this",
              commentType: "discussion" as const,
              source: "human" as const,
              referenceBriefId: null,
              referenceStandardId: null,
              referenceDecisionId: null,
              referenceTaskId: null,
              resolution: null,
              resolvedAt: null,
              anchorSnippet: null,
              audience: "all" as const,
              actions: null,
              channel: null,
              createdAt: baseDate,
            },
          ],
        },
      ],
      decisions: [],
      tasks: [],
    });
    vi.mocked(getDoc).mockResolvedValue({ ...makeDoc(), sections: [], creator: null });

    const response = await mcpCall("list_comments", { ref: TEST_DOC_REF, mode: "review" });
    const text = response.result.content[0].text;

    expect(text).toContain("# Review:");
    expect(text).toContain("Current section text");
    expect(text).toContain("Please expand this");
    // doc-14: review mode defaults to excluding `progress` (MCP-layer policy
    // per Section 7 of doc-10). The third arg is the typed-comment filter.
    const call = vi.mocked(reviewDocComments).mock.calls[0];
    expect(call[0]).toBe(TEST_MEMEX_ID);
    expect(call[1]).toBe(TEST_DOC_ID);
    const filter = call[2]?.typeFilter as string[] | undefined;
    expect(filter).toBeDefined();
    expect(filter).not.toContain("progress");
    expect(filter).toContain("question");
  });
});

// Avoid unused-import warnings for the resolved-account constants that some tests don't
// reference directly.
void TEST_DECISION_ID;
void TEST_TASK_ID;
void TEST_COMMENT_ID;
void TEST_DECISION_REF;
void TEST_TASK_REF;
void TEST_COMMENT_REF;
