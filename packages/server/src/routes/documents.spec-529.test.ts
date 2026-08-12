// spec-529 t-2 — the `?handles=` filter and the `taskProgress` include on the docs
// list route, the ONE request a document view makes to resolve every `spec-N` its
// body mentions.
//
// Mock-based (no DB), mirroring documents.tags.test.ts: stub the services + session
// middleware, then assert the handler turns query params into listDocs options. The
// aggregation itself is covered service-side; what is proved here is the wiring and
// the boundary's parsing, which is where a malformed handle in prose would otherwise
// take down a whole page's resolution.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
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
  parseTagInput: (raw: string) => ({ scope: null, value: raw }),
  listDocTags: vi.fn(),
  listMemexTags: vi.fn(),
  listMemexTagsWithCounts: vi.fn(),
  listDocTagsForDocs: vi.fn().mockResolvedValue(new Map()),
  applyTagStrings: vi.fn(),
  removeTagFromDoc: vi.fn(),
  createTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
}));

import { docs } from "./documents.js";
import { listDocs } from "../services/documents.js";

const TEST_MEMEX_ID = "00000000-0000-0000-0000-000000000001";
const TEST_USER_ID = "00000000-0000-0000-0000-000000000010";

const app = makeTestAppWithTenant({ memexId: TEST_MEMEX_ID, userId: TEST_USER_ID });
app.route("/api/docs", docs);

function optsFromLastCall() {
  return (listDocs as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  (listDocs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe("GET /api/docs — spec-529 reference resolution", () => {
  it("passes a CSV handle set through as a handle filter", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-529/acs/ac-10");
    const res = await app.request("/api/docs?handles=spec-335,spec-373,spec-371");
    expect(res.status).toBe(200);
    expect(optsFromLastCall().handles).toEqual(["spec-335", "spec-373", "spec-371"]);
  });

  it("accepts repeated params and de-duplicates the set", async () => {
    const res = await app.request("/api/docs?handles=spec-335&handles=spec-335,spec-373");
    expect(res.status).toBe(200);
    expect(optsFromLastCall().handles).toEqual(["spec-335", "spec-373"]);
  });

  it("drops malformed handles instead of failing the whole resolution", async () => {
    // A rendered body is the caller here. One odd string in prose must not 400 the
    // page, and a dropped handle is indistinguishable from an unreadable one.
    const res = await app.request(
      "/api/docs?handles=spec-335,Spec-9,spec-007,spec-0,spec-,nonsense,spec-3a",
    );
    expect(res.status).toBe(200);
    expect(optsFromLastCall().handles).toEqual(["spec-335"]);
  });

  it("filters to nothing rather than the whole Memex when every handle is dropped", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-529/acs/ac-11");
    const res = await app.request("/api/docs?handles=nonsense");
    expect(res.status).toBe(200);
    // An explicit `?handles=` still means "these Specs" — an empty array, never undefined.
    expect(optsFromLastCall().handles).toEqual([]);
  });

  it("leaves the handle filter unset when the caller does not ask", async () => {
    const res = await app.request("/api/docs?type=spec");
    expect(res.status).toBe(200);
    expect(optsFromLastCall().handles).toBeUndefined();
  });

  it("turns ?include=taskProgress into the service opt, and leaves it off otherwise", async () => {
    await app.request("/api/docs?include=taskProgress,acHealth");
    expect(optsFromLastCall().includeTaskProgress).toBe(true);
    expect(optsFromLastCall().includeAcHealth).toBe(true);

    await app.request("/api/docs?include=acHealth");
    expect(optsFromLastCall().includeTaskProgress).toBe(false);
  });
});
