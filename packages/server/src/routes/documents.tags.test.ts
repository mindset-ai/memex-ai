// spec-136 t-4 — UNTAGGED route tests for the REST tag surface the React UI consumes.
//
// Mock-based (no DB), mirroring documents.test.ts: stub the services + session
// middleware, then assert the handlers wire query/body → service calls and shape
// the JSON the picker / cards expect. NOT tagged with tagAc — safe to run in auto mode.
//
// Adapted to develop: GET routes go behind the PERMISSIVE publicSessionMiddleware and
// resolve via the `currentMemexId` the tenant stub injects; per-doc tags are attached
// only under `?include=tags` (the develop include-token convention, not the
// pre-develop unconditional attach). Mutating routes read `currentUserId` as the
// link's `added_by` and pass a `{channel:'rest_ui'}` RequestCtx (spec-122 attribution).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMiddleware } from "hono/factory";
import { makeTestAppWithTenant, passthroughMiddleware } from "./route-test-helpers.js";

vi.mock("../middleware/session.js", () => ({
  sessionMiddleware: passthroughMiddleware,
  publicSessionMiddleware: passthroughMiddleware,
}));

vi.mock("../services/documents.js", () => ({
  listDocs: vi.fn(),
  getDoc: vi.fn(),
}));

vi.mock("../services/sections.js", () => ({ splitSection: vi.fn() }));
vi.mock("../services/decisions.js", () => ({ listDecisions: vi.fn().mockResolvedValue([]) }));
vi.mock("../services/tasks.js", () => ({ listTasks: vi.fn().mockResolvedValue([]) }));
vi.mock("../services/share-tokens.js", () => ({
  createShareToken: vi.fn(),
  listShareTokensForDoc: vi.fn(),
  revokeShareToken: vi.fn(),
}));

vi.mock("../services/tags.js", () => ({
  // parseTagInput must keep real semantics so the route's filter parsing is exercised.
  parseTagInput: (raw: string) => {
    const idx = raw.indexOf("::");
    if (idx === -1) return { scope: null, value: raw };
    return { scope: raw.slice(0, idx) || null, value: raw.slice(idx + 2) };
  },
  listDocTags: vi.fn(),
  listMemexTags: vi.fn(),
  listMemexTagsWithCounts: vi.fn(),
  listDocTagsForDocs: vi.fn(),
  applyTagStrings: vi.fn(),
  removeTagFromDoc: vi.fn(),
  createTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}));

import { docs } from "./documents.js";
import { listDocs, getDoc } from "../services/documents.js";
import { ValidationError, NotFoundError } from "../types/errors.js";
import {
  listDocTags,
  listMemexTags,
  listMemexTagsWithCounts,
  listDocTagsForDocs,
  applyTagStrings,
  removeTagFromDoc,
  createTag,
  renameTag,
  deleteTag,
} from "../services/tags.js";

const TEST_MEMEX_ID = "00000000-0000-0000-0000-000000000001";
const TEST_USER_ID = "00000000-0000-0000-0000-000000000010";

// The tenant stub sets `user`/`currentMemexId`/`currentRole` but not `currentUserId`
// (the seam the POST routes read for `added_by`). Inject it explicitly so the
// attribution assertion is meaningful.
const setCurrentUserId = createMiddleware(async (c, next) => {
  c.set("currentUserId", TEST_USER_ID);
  return next();
});

const app = makeTestAppWithTenant({ memexId: TEST_MEMEX_ID, userId: TEST_USER_ID });
app.use("*", setCurrentUserId);
app.route("/api/docs", docs);

const baseDate = new Date("2026-06-02T12:00:00Z");
const tag = (scope: string | null, value: string) => ({
  id: `${scope ?? "flat"}-${value}`,
  memexId: TEST_MEMEX_ID,
  scope,
  value,
  createdAt: baseDate,
});

const summary = (id: string, handle: string) => ({
  id,
  memexId: TEST_MEMEX_ID,
  handle,
  title: `Spec ${id}`,
  docType: "spec",
  status: "build",
  parentDocId: null,
  createdAt: baseDate,
  statusChangedAt: baseDate,
  sectionCount: 1,
  archivedAt: null,
});

describe("GET /api/docs (tag filter)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards repeated ?tags= as a parsed ParsedTag[] filter", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs?type=spec&tags=priority::high&tags=bug");
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: "spec",
      includeDriftCount: false,
      includeAcHealth: false,
      includeAssignees: false,
      tags: [
        { scope: "priority", value: "high" },
        { scope: null, value: "bug" },
      ],
    });
  });

  it("accepts CSV ?tags=a,b form", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs?tags=priority::low,flat");
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: undefined,
      includeDriftCount: false,
      includeAcHealth: false,
      includeAssignees: false,
      tags: [
        { scope: "priority", value: "low" },
        { scope: null, value: "flat" },
      ],
    });
  });

  it("omits the tags filter when none supplied", async () => {
    vi.mocked(listDocs).mockResolvedValue([]);

    await app.request("/api/docs");
    expect(listDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, {
      docType: undefined,
      includeDriftCount: false,
      includeAcHealth: false,
      includeAssignees: false,
    });
  });
});

describe("GET /api/docs?include=tags (attach)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("attaches each doc's tags to the response via a single batch lookup", async () => {
    vi.mocked(listDocs).mockResolvedValue([summary("uuid-1", "spec-1")]);
    vi.mocked(listDocTagsForDocs).mockResolvedValue(
      new Map([["uuid-1", [tag("priority", "high")]]]),
    );

    const res = await app.request("/api/docs?include=tags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].tags).toHaveLength(1);
    expect(body[0].tags[0].value).toBe("high");
    expect(listDocTagsForDocs).toHaveBeenCalledWith(TEST_MEMEX_ID, ["uuid-1"]);
  });

  it("defaults to [] for docs with no tags", async () => {
    vi.mocked(listDocs).mockResolvedValue([summary("uuid-2", "spec-2")]);
    vi.mocked(listDocTagsForDocs).mockResolvedValue(new Map());

    const res = await app.request("/api/docs?include=tags");
    const body = await res.json();
    expect(body[0].tags).toEqual([]);
  });

  it("does NOT attach tags (no batch lookup) when include=tags is absent", async () => {
    vi.mocked(listDocs).mockResolvedValue([summary("uuid-3", "spec-3")]);

    const res = await app.request("/api/docs");
    const body = await res.json();
    expect(body[0].tags).toBeUndefined();
    expect(listDocTagsForDocs).not.toHaveBeenCalled();
  });
});

describe("GET /api/docs/tags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the whole Memex tag catalogue", async () => {
    vi.mocked(listMemexTags).mockResolvedValue([tag("priority", "high"), tag(null, "bug")]);

    const res = await app.request("/api/docs/tags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(listMemexTags).toHaveBeenCalledWith(TEST_MEMEX_ID);
    // /tags must NOT be swallowed by the /:id param route.
    expect(getDoc).not.toHaveBeenCalled();
  });
});

describe("GET /api/docs/tags/with-counts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the catalogue with each tag's assignedCount via the single aggregate", async () => {
    vi.mocked(listMemexTagsWithCounts).mockResolvedValue([
      { ...tag("priority", "high"), assignedCount: 3 },
      { ...tag(null, "bug"), assignedCount: 0 },
    ] as never);

    const res = await app.request("/api/docs/tags/with-counts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].assignedCount).toBe(3);
    expect(body[1].assignedCount).toBe(0);
    expect(listMemexTagsWithCounts).toHaveBeenCalledWith(TEST_MEMEX_ID);
    // The literal `/tags/with-counts` must NOT be swallowed by the `/:id` param route.
    expect(getDoc).not.toHaveBeenCalled();
  });
});

describe("GET /api/docs/:id (tags inline)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes the doc's tags in the payload", async () => {
    vi.mocked(getDoc).mockResolvedValue({
      id: "uuid-1",
      memexId: TEST_MEMEX_ID,
      handle: "spec-1",
      title: "Spec One",
      docType: "spec",
      status: "build",
      parentDocId: null,
      createdByUserId: null,
      createdAt: baseDate,
      statusChangedAt: baseDate,
      archivedAt: null,
      sections: [],
    } as never);
    vi.mocked(listDocTags).mockResolvedValue([tag("priority", "high")]);

    const res = await app.request("/api/docs/uuid-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0].scope).toBe("priority");
    expect(listDocTags).toHaveBeenCalledWith(TEST_MEMEX_ID, "uuid-1");
  });
});

describe("POST /api/docs/:id/tags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies tags via applyTagStrings (one batch call) with the session user as added_by and a rest_ui channel", async () => {
    vi.mocked(applyTagStrings).mockResolvedValue([tag("priority", "high"), tag(null, "bug")]);
    vi.mocked(listDocTags).mockResolvedValue([tag(null, "bug"), tag("priority", "high")]);

    const res = await app.request("/api/docs/uuid-1/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: ["priority::high", "bug"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toHaveLength(2);
    expect(body.tags).toHaveLength(2);
    expect(applyTagStrings).toHaveBeenCalledTimes(1);
    expect(applyTagStrings).toHaveBeenCalledWith(
      { channel: "rest_ui" },
      TEST_MEMEX_ID,
      "uuid-1",
      ["priority::high", "bug"],
      TEST_USER_ID,
    );
  });

  it("400s when tags is not an array of strings", async () => {
    const res = await app.request("/api/docs/uuid-1/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: "priority::high" }),
    });
    expect(res.status).toBe(400);
    expect(applyTagStrings).not.toHaveBeenCalled();
  });
});

describe("POST /api/docs/:id/tags/remove", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the tag link by tagId and returns the remaining set", async () => {
    vi.mocked(removeTagFromDoc).mockResolvedValue({ removed: 1 } as never);
    vi.mocked(listDocTags).mockResolvedValue([tag("priority", "high")]);

    const res = await app.request("/api/docs/uuid-1/tags/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagId: "flat-bug" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tags).toHaveLength(1);
    expect(removeTagFromDoc).toHaveBeenCalledWith(
      { channel: "rest_ui" },
      TEST_MEMEX_ID,
      "uuid-1",
      "flat-bug",
    );
  });

  it("400s when tagId is missing", async () => {
    const res = await app.request("/api/docs/uuid-1/tags/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(removeTagFromDoc).not.toHaveBeenCalled();
  });
});

// ── Tag catalogue curation routes (spec-418 t-3) ──────────────────────────────
// WIRING tests: assert the create/rename/delete routes call the tags-service
// curation functions with the right args (incl. the rest_ui-channelled RequestCtx),
// that the literal /tags routes aren't swallowed by /:id, and that a service
// ValidationError→400 / NotFoundError→404 surfaces the plain reason. UNtagged.
describe("POST /api/docs/tags (create catalogue tag)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mints a tag from a `scope::value` string and returns 201 with the created row", async () => {
    vi.mocked(createTag).mockResolvedValue(tag("priority", "high") as never);

    const res = await app.request("/api/docs/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "priority::high" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.value).toBe("high");
    expect(createTag).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "rest_ui", actorUserId: TEST_USER_ID }),
      TEST_MEMEX_ID,
      "priority",
      "high",
    );
    // /tags must NOT be swallowed by the /:id param route (no getDoc side effect).
    expect(getDoc).not.toHaveBeenCalled();
  });

  it("accepts a structured { scope, value } body", async () => {
    vi.mocked(createTag).mockResolvedValue(tag("area", "mcp") as never);

    const res = await app.request("/api/docs/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "area", value: "mcp" }),
    });
    expect(res.status).toBe(201);
    expect(createTag).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "rest_ui" }),
      TEST_MEMEX_ID,
      "area",
      "mcp",
    );
  });

  it("mints a FLAT tag (no scope) from a bare string", async () => {
    vi.mocked(createTag).mockResolvedValue(tag(null, "bug") as never);

    const res = await app.request("/api/docs/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "bug" }),
    });
    expect(res.status).toBe(201);
    expect(createTag).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "rest_ui" }),
      TEST_MEMEX_ID,
      null,
      "bug",
    );
  });

  it("surfaces a service duplicate block as 400 with the plain reason", async () => {
    vi.mocked(createTag).mockRejectedValue(
      new ValidationError('A tag named "priority::high" already exists'),
    );

    const res = await app.request("/api/docs/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "priority::high" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('A tag named "priority::high" already exists');
  });

  it("400s when the body carries neither a `tag` string nor a `value`", async () => {
    const res = await app.request("/api/docs/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "priority" }),
    });
    expect(res.status).toBe(400);
    expect(createTag).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/docs/tags/:tagId (rename catalogue tag)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renames via renameTag(ctx, memexId, tagId, scope, value) and returns the updated row", async () => {
    vi.mocked(renameTag).mockResolvedValue(tag("priority", "urgent") as never);

    const res = await app.request("/api/docs/tags/tag-123", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "priority::urgent" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe("urgent");
    expect(renameTag).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "rest_ui", actorUserId: TEST_USER_ID }),
      TEST_MEMEX_ID,
      "tag-123",
      "priority",
      "urgent",
    );
  });

  it("surfaces a blocked rename (service ValidationError) as 400 with the plain reason", async () => {
    vi.mocked(renameTag).mockRejectedValue(
      new ValidationError('A tag named "priority::low" already exists'),
    );

    const res = await app.request("/api/docs/tags/tag-123", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "priority::low" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('A tag named "priority::low" already exists');
  });

  it("404s when the tag isn't in this Memex (service NotFoundError)", async () => {
    vi.mocked(renameTag).mockRejectedValue(new NotFoundError("Tag tag-x not found in this Memex"));

    const res = await app.request("/api/docs/tags/tag-x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "priority::high" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/docs/tags/:tagId (delete catalogue tag)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes via deleteTag(ctx, memexId, tagId) and returns the blast radius", async () => {
    vi.mocked(deleteTag).mockResolvedValue({ removed: 1, affectedDocIds: ["uuid-1"] } as never);

    const res = await app.request("/api/docs/tags/tag-123", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(1);
    expect(body.affectedDocIds).toEqual(["uuid-1"]);
    expect(deleteTag).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "rest_ui", actorUserId: TEST_USER_ID }),
      TEST_MEMEX_ID,
      "tag-123",
    );
  });

  it("404s when the tag isn't in this Memex (service NotFoundError)", async () => {
    vi.mocked(deleteTag).mockRejectedValue(new NotFoundError("Tag tag-x not found in this Memex"));

    const res = await app.request("/api/docs/tags/tag-x", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
