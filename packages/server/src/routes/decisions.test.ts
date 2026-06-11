import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestAppWithTenant, passthroughMiddleware } from "./route-test-helpers.js";
import { testMutate } from "../services/__test__/mutate-helpers.js";

// Mock session middleware (t-13) so the route's `.use()` is a pass-through and the stubbed
// currentAccount/user from `makeTestAppWithTenant` reach the handler intact.
vi.mock("../middleware/session.js", () => ({
  sessionMiddleware: passthroughMiddleware,
  publicSessionMiddleware: passthroughMiddleware,
}));

vi.mock("../services/decisions.js", () => ({
  createDecision: vi.fn(),
  listDecisions: vi.fn(),
  resolveDecision: vi.fn(),
  reopenDecision: vi.fn(),
  approveDecision: vi.fn(),
  rejectDecision: vi.fn(),
}));

import { decisionsRouter } from "./decisions.js";
import {
  createDecision,
  listDecisions,
  resolveDecision,
  reopenDecision,
  approveDecision,
  rejectDecision,
} from "../services/decisions.js";
import { NotFoundError, ValidationError } from "../types/errors.js";

const TEST_MEMEX_ID = "00000000-0000-0000-0000-000000000001";
const app = makeTestAppWithTenant({ memexId: TEST_MEMEX_ID });
app.route("/api/decisions", decisionsRouter);

const baseDate = new Date("2026-03-25T12:00:00Z");

function makeDecision(overrides = {}) {
  return {
    id: "dec-uuid-1",
    memexId: "test-account",
    docId: "doc-1",
    seq: 1,
    title: "Use REST or gRPC?",
    context: null,
    status: "open",
    options: null,
    chosenOptionIndex: null,
    // Provenance, added in t-20 W-C / 0027_v2_deferral_fixes; tests default to
    // 'human' which matches the schema default for direct-create paths.
    source: "human" as const,
    resolution: null,
    resolvedAt: null,
    // Captured at delete_decision time (b-97); null for non-deleted rows.
    previousStatus: null,
    createdAt: baseDate,
    actorUserId: null,
    actorName: null,
    channel: null,
    ...overrides,
  };
}

describe("GET /api/decisions/doc/:docId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of decisions", async () => {
    vi.mocked(listDecisions).mockResolvedValue([makeDecision()]);

    const res = await app.request("/api/decisions/doc/doc-1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe("Use REST or gRPC?");
    // b-97: the route passes a third `{ includeDeleted }` arg derived from
    // the `?include` query string; default is "hide deleted".
    expect(listDecisions).toHaveBeenCalledWith(TEST_MEMEX_ID, "doc-1", {
      includeDeleted: false,
    });
  });

  it("passes includeDeleted: true when ?include=deleted is set (b-97)", async () => {
    vi.mocked(listDecisions).mockResolvedValue([makeDecision()]);

    const res = await app.request("/api/decisions/doc/doc-1?include=deleted");
    expect(res.status).toBe(200);
    expect(listDecisions).toHaveBeenCalledWith(TEST_MEMEX_ID, "doc-1", {
      includeDeleted: true,
    });
  });
});

describe("POST /api/decisions/doc/:docId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a decision and returns 201", async () => {
    vi.mocked(createDecision).mockResolvedValue(testMutate(makeDecision()));

    const res = await app.request("/api/decisions/doc/doc-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Use REST or gRPC?" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Use REST or gRPC?");
    // 5th arg is the t-20 W-C source argument; the route defaults it to 'human'
    // when the body omits it (REST is the human-authoring surface).
    expect(createDecision).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "doc-1",
      "Use REST or gRPC?",
      undefined,
      "human",
      expect.anything(),
    );
  });

  it("passes optional context", async () => {
    vi.mocked(createDecision).mockResolvedValue(testMutate(makeDecision({ context: "Need ACID" })));

    await app.request("/api/decisions/doc/doc-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Which DB?", context: "Need ACID" }),
    });

    expect(createDecision).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "doc-1",
      "Which DB?",
      "Need ACID",
      "human",
      expect.anything(),
    );
  });

  it("forwards an explicit source='agent' when provided in the body (t-20 W-C)", async () => {
    vi.mocked(createDecision).mockResolvedValue(testMutate(makeDecision({ source: "agent" })));

    await app.request("/api/decisions/doc/doc-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Agent direct", source: "agent" }),
    });

    expect(createDecision).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "doc-1",
      "Agent direct",
      undefined,
      "agent",
      expect.anything(),
    );
  });
});

describe("POST /api/decisions/:id/resolve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a decision", async () => {
    vi.mocked(resolveDecision).mockResolvedValue(testMutate(makeDecision({ status: "resolved", resolution: "Go with REST" })));

    const res = await app.request("/api/decisions/dec-uuid-1/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution: "Go with REST" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("resolved");
    expect(resolveDecision).toHaveBeenCalledWith(TEST_MEMEX_ID, "dec-uuid-1", "Go with REST", undefined, expect.anything());
  });

  it("returns 404 for non-existent decision", async () => {
    vi.mocked(resolveDecision).mockRejectedValue(
      new NotFoundError("Decision not found")
    );

    const res = await app.request("/api/decisions/bad-id/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution: "Whatever" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/decisions/:id/reopen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reopens a decision", async () => {
    vi.mocked(reopenDecision).mockResolvedValue(testMutate(makeDecision({ status: "open", resolution: "Proposed: REST" })));

    const res = await app.request("/api/decisions/dec-uuid-1/reopen", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("open");
    expect(reopenDecision).toHaveBeenCalledWith(TEST_MEMEX_ID, "dec-uuid-1");
  });
});

describe("POST /api/decisions/:id/approve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approves a candidate (candidate → open)", async () => {
    vi.mocked(approveDecision).mockResolvedValue(testMutate(makeDecision({ status: "open" })));

    const res = await app.request("/api/decisions/dec-uuid-1/approve", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("open");
    expect(approveDecision).toHaveBeenCalledWith(TEST_MEMEX_ID, "dec-uuid-1");
  });

  it("returns 400 when the decision is not a candidate", async () => {
    vi.mocked(approveDecision).mockRejectedValue(
      new ValidationError("Only candidate decisions can be approved (current status: open)")
    );

    const res = await app.request("/api/decisions/dec-uuid-1/approve", {
      method: "POST",
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/decisions/:id/reject", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a candidate with a reason", async () => {
    vi.mocked(rejectDecision).mockResolvedValue(testMutate(makeDecision({ status: "rejected", resolution: "Out of scope" })));

    const res = await app.request("/api/decisions/dec-uuid-1/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Out of scope" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("rejected");
    expect(body.resolution).toBe("Out of scope");
    expect(rejectDecision).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "dec-uuid-1",
      "Out of scope",
    );
  });

  it("returns 400 when the decision is not a candidate", async () => {
    vi.mocked(rejectDecision).mockRejectedValue(
      new ValidationError("Only candidate decisions can be rejected (current status: open)")
    );

    const res = await app.request("/api/decisions/dec-uuid-1/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Out of scope" }),
    });

    expect(res.status).toBe(400);
  });
});
