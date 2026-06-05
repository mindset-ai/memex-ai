// spec-126 — the review overlay consumes the REAL resolveRole (dec-6 / ac-10),
// and a non-member defaults to reviewer (ac-4).
//
// This drives the overlay's gate (isToolAllowedForReviewer + getToolDefinitions)
// with roles produced by the ACTUAL resolver against a seeded doc_members row —
// not a mocked role value — proving the wiring is real, per dec-6 (the spec-118
// read-path is present in this branch, so we build against it, not a stub).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { resolveRole } from "./doc-members.js";
import { upsertUserByEmail } from "./users.js";
import { makeTestMemex } from "./test-helpers.js";
import { getToolDefinitions, isToolAllowedForReviewer } from "../agent/tools.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-126/acs/ac-${n}`;

const toolNames = (tools: ReturnType<typeof getToolDefinitions>) =>
  new Set(tools.map((t) => (t as { name: string }).name));

const createdDocIds: string[] = [];
afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)); // CASCADE clears doc_members
  }
});

let memexId: string;
let editorUser: { id: string };
let reviewerUser: { id: string };
let docId: string;

beforeAll(async () => {
  memexId = await makeTestMemex();
  editorUser = await upsertUserByEmail("spec126-editor@example.com");
  reviewerUser = await upsertUserByEmail("spec126-reviewer@example.com");
  // The creator is seeded as the sole editor (spec-118). reviewerUser has no row.
  const doc = await createDocDraft(
    memexId,
    "Review Overlay Spec",
    "purpose",
    "spec",
    undefined,
    undefined,
    editorUser.id,
  );
  docId = doc.id;
  createdDocIds.push(doc.id);
});

describe("spec-126 review overlay against the real resolveRole", () => {
  it("a member with no doc_members row resolves to reviewer (ac-4)", async () => {
    tagAc(AC(4));
    expect(await resolveRole(memexId, docId, reviewerUser.id)).toBe("reviewer");
    // An unauthenticated viewer (no userId) is also a reviewer.
    expect(await resolveRole(memexId, docId, null)).toBe("reviewer");
  });

  it("the real reviewer role gates the toolset — blocked mutations dropped, reads/comments kept (ac-10)", async () => {
    tagAc(AC(10));
    const role = await resolveRole(memexId, docId, reviewerUser.id); // REAL resolver
    expect(role).toBe("reviewer");

    const reviewer = role === "reviewer";
    const tools = toolNames(getToolDefinitions({ reviewer }));
    // Blocked for the real reviewer:
    expect(tools.has("resolve_decision")).toBe(false);
    expect(tools.has("update_section")).toBe(false);
    expect(tools.has("create_task")).toBe(false);
    // Allowed for the real reviewer:
    expect(tools.has("get_doc")).toBe(true);
    expect(tools.has("add_comment")).toBe(true);
    // And the execution-gate predicate agrees, driven by the real role.
    expect(isToolAllowedForReviewer("resolve_decision")).toBe(false);
    expect(isToolAllowedForReviewer("add_comment")).toBe(true);
  });

  it("the real editor role leaves the full toolset intact (ac-10)", async () => {
    tagAc(AC(10));
    const role = await resolveRole(memexId, docId, editorUser.id); // REAL resolver
    expect(role).toBe("editor");

    const reviewer = role === "reviewer"; // false
    const tools = toolNames(getToolDefinitions({ reviewer }));
    expect(tools.has("resolve_decision")).toBe(true);
    expect(tools.has("update_section")).toBe(true);
  });
});
