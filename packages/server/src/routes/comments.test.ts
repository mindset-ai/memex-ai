import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { makeTestAppWithTenant, passthroughMiddleware } from "./route-test-helpers.js";
import { testMutate } from "../services/__test__/mutate-helpers.js";

// spec-143 dec-4: POST /api/comments/:id/resolve threads the optional resolution
// argument through to services/comments.ts::resolveComment, so Reject ('rejected')
// and Resolve ('resolved') are distinguishable in history.
const AC_RESOLUTION_THREADING =
  "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-12";
// spec-259 ac-4: the resolve route threads the acting user's RequestCtx so the
// resolution carries WHO (proven end-to-end in comment-resolution-attribution.spec-259).
const AC_RESOLVE_ATTRIBUTION =
  "mindset-prod/memex-building-itself/specs/spec-259/acs/ac-4";

// Mock session middleware (t-13) so the route's `.use()` is a pass-through and the stubbed
// currentAccount/user from `makeTestAppWithTenant` reach the handler intact.
vi.mock("../middleware/session.js", () => ({
  sessionMiddleware: passthroughMiddleware,
  publicSessionMiddleware: passthroughMiddleware,
}));

vi.mock("../services/comments.js", () => ({
  addComment: vi.fn(),
  addAnchoredComment: vi.fn(),
  listComments: vi.fn(),
  listCommentsForDoc: vi.fn(),
  resolveComment: vi.fn(),
  unresolveComment: vi.fn(),
}));

import { comments } from "./comments.js";
import {
  addComment,
  addAnchoredComment,
  listComments,
  listCommentsForDoc,
  resolveComment,
  unresolveComment,
} from "../services/comments.js";
import { NotFoundError } from "../types/errors.js";

const TEST_MEMEX_ID = "00000000-0000-0000-0000-000000000001";
const app = makeTestAppWithTenant({ memexId: TEST_MEMEX_ID });
app.route("/api/comments", comments);

const baseDate = new Date("2026-03-25T12:00:00Z");

describe("GET /api/comments/doc/:docId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns comments grouped by section", async () => {
    vi.mocked(listCommentsForDoc).mockResolvedValue({
      sections: [
        {
          section: {
            id: "s1",
            docId: "d1",
            sectionType: "purpose",
            title: "Purpose",
            description: null,
            content: "Content",
            seq: 1,
            status: "active",
            preamble: null,
            position: 1,
            previousStatus: null,
            createdAt: baseDate,
            updatedAt: baseDate,
            actorUserId: null,
            actorName: null,
            channel: null,
          },
          comments: [
            {
              id: "c1",
              memexId: "test-account",
              docId: "d1",
              seq: 1,
              sectionId: "s1",
              decisionId: null,
              taskId: null,
              commentType: "discussion" as const,
              source: "human" as const,
              referenceBriefId: null,
              referenceStandardId: null,
              referenceDecisionId: null,
              referenceTaskId: null,
              authorName: "Alice",
              authorUserId: null,
      authorNamespaceId: null,
      content: "Great!",
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

    const res = await app.request("/api/comments/doc/d1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].comments).toHaveLength(1);
    expect(body.sections[0].comments[0].authorName).toBe("Alice");
    expect(body.decisions).toHaveLength(0);
    expect(body.tasks).toHaveLength(0);
  });

  it("returns 404 when document not found", async () => {
    vi.mocked(listCommentsForDoc).mockRejectedValue(
      new NotFoundError("Document xyz not found")
    );

    const res = await app.request("/api/comments/doc/xyz");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/comments/section/:sectionId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns comments for a section", async () => {
    vi.mocked(listComments).mockResolvedValue([
      {
        id: "c1",
        memexId: "test-account",
        docId: "d1",
        seq: 1,
        sectionId: "s1",
        decisionId: null,
        taskId: null,
              commentType: "discussion" as const,
              source: "human" as const,
              referenceBriefId: null,
              referenceStandardId: null,
              referenceDecisionId: null,
              referenceTaskId: null,
        authorName: "Bob",
        authorUserId: null,
      authorNamespaceId: null,
      content: "Needs work",
        resolution: null,
        resolvedAt: null,
        anchorSnippet: null,
        audience: "all" as const,
        actions: null,
        channel: null,
        createdAt: baseDate,
      },
    ]);

    const res = await app.request("/api/comments/section/s1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].content).toBe("Needs work");
  });
});

describe("POST /api/comments/section/:sectionId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a comment and returns 201", async () => {
    vi.mocked(addComment).mockResolvedValue(testMutate({
      id: "c-new",
      memexId: "test-account",
      docId: "d1",
      seq: 1,
      sectionId: "s1",
      decisionId: null,
      taskId: null,
              commentType: "discussion" as const,
              source: "human" as const,
              referenceBriefId: null,
              referenceStandardId: null,
              referenceDecisionId: null,
              referenceTaskId: null,
      authorName: "Alice",
      authorUserId: null,
      authorNamespaceId: null,
      content: "My comment",
      resolution: null,
      resolvedAt: null,
      anchorSnippet: null,
      audience: "all" as const,
      actions: null,
      channel: null,
      createdAt: baseDate,
    }));

    const res = await app.request("/api/comments/section/s1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorName: "Alice", content: "My comment" }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.id).toBe("c-new");
    // extras now always passed (carries the stamped authorUserId when a session
    // user is present; empty object otherwise).
    expect(addComment).toHaveBeenCalledWith(TEST_MEMEX_ID, "s1", "Alice", "My comment", expect.any(Object));
  });

  it("routes to addAnchoredComment when anchorOffset is supplied (spec-100 in-situ create)", async () => {
    vi.mocked(addAnchoredComment).mockResolvedValue(testMutate({
      id: "c-anchored",
      memexId: "test-account",
      docId: "d1",
      seq: 2,
      sectionId: "s1",
      decisionId: null,
      taskId: null,
      commentType: "issue" as const,
      source: "human" as const,
      referenceBriefId: null,
      referenceStandardId: null,
      referenceDecisionId: null,
      referenceTaskId: null,
      authorName: "Wic",
      authorUserId: null,
      authorNamespaceId: null,
      content: "Anchored here",
      resolution: null,
      resolvedAt: null,
      anchorSnippet: "the proxy emits llm_call events",
      audience: "all" as const,
      actions: null,
      channel: null,
      createdAt: baseDate,
    }));

    const res = await app.request("/api/comments/section/s1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorName: "Wic", content: "Anchored here", type: "issue", anchorOffset: 31 }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.id).toBe("c-anchored");
    expect(body.anchorSnippet).toBe("the proxy emits llm_call events");
    expect(addAnchoredComment).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "s1",
      "Wic",
      "Anchored here",
      31,
      { type: "issue" },
      undefined, // no anchorStartOffset → point anchor
    );
    expect(addComment).not.toHaveBeenCalled();
  });

  it("forwards anchorStartOffset as the range start when supplied (spec-100 range)", async () => {
    vi.mocked(addAnchoredComment).mockResolvedValue(testMutate({
      id: "c-ranged",
      memexId: "test-account",
      docId: "d1",
      seq: 3,
      sectionId: "s1",
      decisionId: null,
      taskId: null,
      commentType: "issue" as const,
      source: "human" as const,
      referenceBriefId: null,
      referenceStandardId: null,
      referenceDecisionId: null,
      referenceTaskId: null,
      authorName: "Wic",
      authorUserId: null,
      authorNamespaceId: null,
      content: "Ranged",
      resolution: null,
      resolvedAt: null,
      anchorSnippet: "Spec-by-Spec",
      audience: "all" as const,
      actions: null,
      channel: null,
      createdAt: baseDate,
    }));

    const res = await app.request("/api/comments/section/s1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorName: "Wic", content: "Ranged", type: "issue", anchorOffset: 31, anchorStartOffset: 19 }),
    });
    expect(res.status).toBe(201);
    expect(addAnchoredComment).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "s1",
      "Wic",
      "Ranged",
      31,
      { type: "issue" },
      19, // anchorStartOffset → range
    );
  });
});

describe("POST /api/comments/:commentId/resolve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a comment without resolution", async () => {
    tagAc(AC_RESOLUTION_THREADING);
    tagAc(AC_RESOLVE_ATTRIBUTION);
    vi.mocked(resolveComment).mockResolvedValue(testMutate({
      id: "c1",
      memexId: "test-account",
      docId: "d1",
      seq: 1,
      sectionId: "s1",
      decisionId: null,
      taskId: null,
              commentType: "discussion" as const,
              source: "human" as const,
              referenceBriefId: null,
              referenceStandardId: null,
              referenceDecisionId: null,
              referenceTaskId: null,
      authorName: "Alice",
      authorUserId: null,
      authorNamespaceId: null,
      content: "Done",
      resolution: null,
      resolvedAt: baseDate,
      anchorSnippet: null,
      audience: "all" as const,
      actions: null,
      channel: null,
      createdAt: baseDate,
    }));

    const res = await app.request("/api/comments/c1/resolve", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.resolvedAt).toBeTruthy();
    // spec-259 ac-4: the route threads the acting user's ctx (restCtx) as the 4th
    // arg so the resolution carries WHO (channel rest_ui + actorUserId).
    expect(resolveComment).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "c1",
      undefined,
      expect.objectContaining({ channel: "rest_ui" }),
    );
  });

  it("resolves a comment with resolution", async () => {
    tagAc(AC_RESOLUTION_THREADING);
    tagAc(AC_RESOLVE_ATTRIBUTION);
    vi.mocked(resolveComment).mockResolvedValue(testMutate({
      id: "c1",
      memexId: "test-account",
      docId: "d1",
      seq: 1,
      sectionId: "s1",
      decisionId: null,
      taskId: null,
              commentType: "discussion" as const,
              source: "human" as const,
              referenceBriefId: null,
              referenceStandardId: null,
              referenceDecisionId: null,
              referenceTaskId: null,
      authorName: "Alice",
      authorUserId: null,
      authorNamespaceId: null,
      content: "Please expand",
      resolution: "Added details",
      resolvedAt: baseDate,
      anchorSnippet: null,
      audience: "all" as const,
      actions: null,
      channel: null,
      createdAt: baseDate,
    }));

    const res = await app.request("/api/comments/c1/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution: "Added details" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.resolution).toBe("Added details");
    expect(resolveComment).toHaveBeenCalledWith(
      TEST_MEMEX_ID,
      "c1",
      "Added details",
      expect.objectContaining({ channel: "rest_ui" }),
    );
  });
});

describe("POST /api/comments/:commentId/unresolve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unresolves a comment", async () => {
    vi.mocked(unresolveComment).mockResolvedValue(testMutate({
      id: "c1",
      memexId: "test-account",
      docId: "d1",
      seq: 1,
      sectionId: "s1",
      decisionId: null,
      taskId: null,
              commentType: "discussion" as const,
              source: "human" as const,
              referenceBriefId: null,
              referenceStandardId: null,
              referenceDecisionId: null,
              referenceTaskId: null,
      authorName: "Alice",
      authorUserId: null,
      authorNamespaceId: null,
      content: "Done",
      resolution: null,
      resolvedAt: null,
      anchorSnippet: null,
      audience: "all" as const,
      actions: null,
      channel: null,
      createdAt: baseDate,
    }));

    const res = await app.request("/api/comments/c1/unresolve", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.resolvedAt).toBeNull();
  });
});
