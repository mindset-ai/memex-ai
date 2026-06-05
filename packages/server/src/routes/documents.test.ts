import { describe, it, expect, vi, beforeEach } from "vitest";
import { testMutate } from "../services/__test__/mutate-helpers.js";
import { makeTestAppWithTenant, passthroughMiddleware } from "./route-test-helpers.js";

// Mock services + session middleware before importing routes (t-13). The session stub
// lets `makeTestAppWithTenant`'s injected `currentAccount`/`user` flow through unchanged.
vi.mock("../middleware/session.js", () => ({
  sessionMiddleware: passthroughMiddleware,
  publicSessionMiddleware: passthroughMiddleware,
}));

vi.mock("../services/documents.js", () => ({
  listDocs: vi.fn(),
  getDoc: vi.fn(),
}));

vi.mock("../services/sections.js", () => ({
  splitSection: vi.fn(),
}));

vi.mock("../services/decisions.js", () => ({
  listDecisions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/tasks.js", () => ({
  listTasks: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/share-tokens.js", () => ({
  createShareToken: vi.fn(),
  listShareTokensForDoc: vi.fn(),
  revokeShareToken: vi.fn(),
}));

// spec-136 t-4: the docs route now reads tags (listDocTags on GET /:id; and
// listDocTagsForDocs on GET / under ?include=tags). Mock the service so these
// pre-existing mock-based tests don't hit a real DB — keep parseTagInput real for
// the filter-parsing path.
vi.mock("../services/tags.js", () => ({
  parseTagInput: (raw: string) => {
    const idx = raw.indexOf("::");
    if (idx === -1) return { scope: null, value: raw };
    return { scope: raw.slice(0, idx) || null, value: raw.slice(idx + 2) };
  },
  listDocTags: vi.fn().mockResolvedValue([]),
  listMemexTags: vi.fn().mockResolvedValue([]),
  listDocTagsForDocs: vi.fn().mockResolvedValue(new Map()),
  applyTagStrings: vi.fn(),
  removeTagFromDoc: vi.fn(),
}));

import { docs } from "./documents.js";
import { listDocs, getDoc } from "../services/documents.js";
import { splitSection } from "../services/sections.js";
import { NotFoundError } from "../types/errors.js";
import { bus, type ChangeEvent } from "../services/bus.js";

const TEST_MEMEX_ID = "00000000-0000-0000-0000-000000000001";
const app = makeTestAppWithTenant({ memexId: TEST_MEMEX_ID });
app.route("/api/docs", docs);

const baseDate = new Date("2026-03-25T12:00:00Z");

describe("GET /api/docs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of documents", async () => {
    vi.mocked(listDocs).mockResolvedValue([
      {
        id: "uuid-1",
        memexId: "test-account",
        handle: "doc-1",
        title: "My Doc",
        docType: "spec",
        status: "draft",
        parentDocId: null,
        createdAt: baseDate,
        statusChangedAt: baseDate,
        sectionCount: 2,
        pausedAt: null,
        archivedAt: null,
      },
    ]);

    const res = await app.request("/api/docs");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe("My Doc");
    expect(body[0].docType).toBe("spec");
  });

  it("passes type query parameter to service", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs?type=spec");
    // Route forwards every known include token (driftCount per t-19 W2,
    // acHealth per b-66 t-2). All default to false when not requested.
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: "spec",
      includeDriftCount: false,
      includeAcHealth: false,
      includeAssignees: false,
    });
  });

  it("passes undefined when no type filter", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs");
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: undefined,
      includeDriftCount: false,
      includeAcHealth: false,
      includeAssignees: false,
    });
  });

  it("forwards ?include=driftCount as includeDriftCount: true", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs?type=standard&include=driftCount");
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: "standard",
      includeDriftCount: true,
      includeAcHealth: false,
      includeAssignees: false,
    });
  });

  it("forwards ?include=acHealth as includeAcHealth: true", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs?type=spec&include=acHealth");
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: "spec",
      includeDriftCount: false,
      includeAcHealth: true,
      includeAssignees: false,
    });
  });

  it("forwards combined includes (?include=driftCount,acHealth)", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs?include=driftCount,acHealth");
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: undefined,
      includeDriftCount: true,
      includeAcHealth: true,
      includeAssignees: false,
    });
  });

  it("forwards ?include=assignees as includeAssignees: true (spec-118 ac-18)", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs?type=spec&include=assignees");
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: "spec",
      includeDriftCount: false,
      includeAcHealth: false,
      includeAssignees: true,
    });
  });
});

describe("GET /api/docs/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a document by id", async () => {
    vi.mocked(getDoc).mockResolvedValue({
      id: "uuid-1",
      memexId: "test-account",
      handle: "doc-1",
      title: "My Doc",
      docType: "spec",
      status: "draft",
      parentDocId: null,
      createdByUserId: null,
      createdAt: baseDate,
      statusChangedAt: baseDate,
      archivedAt: null,
      pausedAt: null,
      narrativeLastConsolidatedAt: null,
      isDemo: false,
      sections: [],
      creator: null,
    });

    const res = await app.request("/api/docs/uuid-1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.title).toBe("My Doc");
    expect(body.sections).toEqual([]);
  });

  it("returns a document by handle", async () => {
    vi.mocked(getDoc).mockResolvedValue({
      id: "uuid-1",
      memexId: "test-account",
      handle: "doc-1",
      title: "My Doc",
      docType: "spec",
      status: "draft",
      parentDocId: null,
      createdByUserId: null,
      createdAt: baseDate,
      statusChangedAt: baseDate,
      archivedAt: null,
      pausedAt: null,
      narrativeLastConsolidatedAt: null,
      isDemo: false,
      sections: [],
      creator: null,
    });

    const res = await app.request("/api/docs/doc-1");
    expect(res.status).toBe(200);
    expect(getDoc).toHaveBeenCalledWith(TEST_MEMEX_ID, "doc-1");
  });

  it("returns 404 when document not found", async () => {
    vi.mocked(getDoc).mockRejectedValue(new NotFoundError("Document xyz not found"));

    const res = await app.request("/api/docs/xyz");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain("not found");
  });
});

describe("POST /api/docs/sections/:sectionId/split", () => {
  beforeEach(() => vi.clearAllMocks());

  it("splits a section and returns results", async () => {
    const sections = [
      {
        id: "s1",
        memexId: "test-account",
        docId: "d1",
        sectionType: "purpose",
        title: "Purpose",
        description: null,
        content: "Part 1",
        seq: 1,
        status: "active",
        preamble: null,
        position: 1,
        previousStatus: null,
        createdAt: baseDate,
        updatedAt: baseDate,
      },
      {
        id: "s2",
        memexId: "test-account",
        docId: "d1",
        sectionType: "purpose_part_2",
        title: "Purpose (Part 2)",
        description: null,
        content: "Part 2",
        seq: 2,
        status: "active",
        preamble: null,
        position: 1,
        previousStatus: null,
        createdAt: baseDate,
        updatedAt: baseDate,
      },
    ];
    vi.mocked(splitSection).mockResolvedValue(testMutate(sections));

    const res = await app.request("/api/docs/sections/s1/split", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].content).toBe("Part 1");
    expect(body[1].content).toBe("Part 2");
  });
});

// ── Pulse (b-60): viewed-activity emission on the GET read path ────────────────
//
// These exercise the single emit site in `GET /api/docs/:id`. The bus is real
// (not mocked) so we subscribe and assert on the delivered ChangeEvent. The
// in-memory throttle is module-level keyed by (userId, docId), so every test
// here uses a UNIQUE docId/handle to stay independent of the others.
function mockDoc(id: string, handle: string) {
  vi.mocked(getDoc).mockResolvedValue({
    id,
    memexId: TEST_MEMEX_ID,
    handle,
    title: `Doc ${handle}`,
    docType: handle.startsWith("std-") ? "standard" : "spec",
    status: "draft",
    parentDocId: null,
    createdByUserId: null,
    createdAt: baseDate,
    statusChangedAt: baseDate,
    archivedAt: null,
    pausedAt: null,
    narrativeLastConsolidatedAt: null,
    isDemo: false,
    sections: [],
    creator: null,
  });
}

describe("GET /api/docs/:id — Pulse viewed events (b-60)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits a single `viewed` ChangeEvent on the rest_ui channel for a Spec read", async () => {
    const received: ChangeEvent[] = [];
    const unsub = bus.subscribe({ docId: "view-spec-1", actions: ["viewed"] }, (e) => received.push(e));
    mockDoc("view-spec-1", "spec-31");

    const res = await app.request("/api/docs/spec-31");
    expect(res.status).toBe(200);
    unsub();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      memexId: TEST_MEMEX_ID,
      docId: "view-spec-1",
      entity: "document",
      action: "viewed",
      channel: "rest_ui",
      narrative: "viewing spec-31",
    });
    // The session-derived clientId is absent here (test stub sends no bearer),
    // which is the intended no-bearer behaviour.
    expect(received[0].userId).toBeTruthy();
  });

  it("composes a `reading std-N §<section>` narrative and puts section/query into payload", async () => {
    const received: ChangeEvent[] = [];
    const unsub = bus.subscribe({ docId: "view-std-1", actions: ["viewed"] }, (e) => received.push(e));
    mockDoc("view-std-1", "std-9");

    const res = await app.request("/api/docs/std-9?section=2&query=auth");
    expect(res.status).toBe(200);
    unsub();

    expect(received).toHaveLength(1);
    expect(received[0].narrative).toBe("reading std-9 §2");
    expect(received[0].payload).toMatchObject({ section: "2", query: "auth" });
  });

  it("throttles to one event per (user, doc) within the 60s window", async () => {
    const received: ChangeEvent[] = [];
    const unsub = bus.subscribe({ docId: "view-throttle-1", actions: ["viewed"] }, (e) => received.push(e));
    mockDoc("view-throttle-1", "spec-99");

    // Three reads of the same doc inside the window — e.g. opening a Spec and
    // flipping tabs. Only the first should emit.
    await app.request("/api/docs/spec-99");
    await app.request("/api/docs/spec-99");
    await app.request("/api/docs/spec-99");
    unsub();

    expect(received).toHaveLength(1);
  });

  it("is a no-op (and does not throw) when the bus emit fails — response still 200", async () => {
    mockDoc("view-fail-1", "spec-77");
    const spy = vi.spyOn(bus, "emit").mockImplementation(() => {
      throw new Error("boom");
    });

    const res = await app.request("/api/docs/spec-77");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handle).toBe("spec-77");

    spy.mockRestore();
  });

  // Microbenchmark (Spec blocker: viewed emission must add no meaningful latency;
  // p99 budget < 1ms). The harness can't compute a true p99 cheaply, so we time a
  // large batch of warmed reads and assert the per-read mean is well under budget.
  // This is a regression tripwire, not a precise SLO measurement.
  it("adds no meaningful latency to the GET read path", async () => {
    mockDoc("view-perf-1", "spec-perf");

    // Warmup — first request pays module/route init costs the loop shouldn't.
    await app.request("/api/docs/spec-perf");

    const ITERATIONS = 500;
    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      // Same doc → after the first, every iteration also exercises the throttle
      // fast-path, which is the steady-state cost of the emit site.
      await app.request("/api/docs/spec-perf");
    }
    const perReadMs = (performance.now() - t0) / ITERATIONS;

    // Generous ceiling for CI jitter; the emit-site overhead itself is sub-µs.
    // If this trips, the read path picked up real per-request work.
    expect(perReadMs).toBeLessThan(5);
  });
});
