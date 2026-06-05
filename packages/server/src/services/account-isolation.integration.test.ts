import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { NotFoundError } from "../types/errors.js";
import { db } from "../db/connection.js";
import { memexes, orgMemberships, documents, users } from "../db/schema.js";
import { inArray } from "drizzle-orm";
import { makeTestMemex } from "./test-helpers.js";
import { createDocDraft, listDocs, getDoc, updateDocStatus } from "./documents.js";
import { createDecision, listDecisions } from "./decisions.js";
import { createTask, listTasks, updateTaskStatus } from "./tasks.js";
import { addComment, listComments } from "./comments.js";
import { addSection, updateSection } from "./sections.js";

// End-to-end isolation tests for t-9: verify that a user in account A cannot read or mutate
// resources belonging to account B. The service layer is the enforcement point — these tests
// don't go through the HTTP layer because that's covered by the route+middleware tests.

let accountA: string;
let accountB: string;

beforeAll(async () => {
  accountA = await makeTestMemex("isoa");
  accountB = await makeTestMemex("isob");
});

afterAll(async () => {
  // Cascade through memexes (which cascades all child resources)
  await db.delete(memexes).where(inArray(memexes.id, [accountA, accountB])).catch(() => {});
});

describe("Cross-account access — documents", () => {
  it("listDocs returns only the requesting account's docs", async () => {
    const docA = await createDocDraft(accountA, "Doc in A", "Purpose A");
    const docB = await createDocDraft(accountB, "Doc in B", "Purpose B");

    const aDocs = await listDocs(accountA);
    const bDocs = await listDocs(accountB);

    expect(aDocs.find((d) => d.id === docA.id)).toBeTruthy();
    expect(aDocs.find((d) => d.id === docB.id)).toBeUndefined();
    expect(bDocs.find((d) => d.id === docB.id)).toBeTruthy();
    expect(bDocs.find((d) => d.id === docA.id)).toBeUndefined();
  });

  it("getDoc by id throws NotFoundError when called from a different account", async () => {
    const docA = await createDocDraft(accountA, "A only", "Purpose");
    await expect(getDoc(accountB, docA.id)).rejects.toThrow(NotFoundError);
    // Sanity: same account can read it
    const reread = await getDoc(accountA, docA.id);
    expect(reread.id).toBe(docA.id);
  });

  it("getDoc by handle is scoped per account (handle lookup respects memexId)", async () => {
    const fromA = await createDocDraft(accountA, "Per-account A", "Purpose");
    const fromB = await createDocDraft(accountB, "Per-account B", "Purpose");

    // Each account resolves its own handle to its own doc (no cross-leak even if handles differ)
    const aLookup = await getDoc(accountA, fromA.handle);
    const bLookup = await getDoc(accountB, fromB.handle);
    expect(aLookup.id).toBe(fromA.id);
    expect(bLookup.id).toBe(fromB.id);

    // Cross-account handle lookups fail (B asking for A's handle returns NotFound)
    await expect(getDoc(accountB, fromA.handle)).rejects.toThrow(NotFoundError);
  });

  it("updateDocStatus throws NotFoundError when document belongs to another account", async () => {
    const docA = await createDocDraft(accountA, "Status A", "Purpose");
    await expect(updateDocStatus(accountB, docA.id, "review")).rejects.toThrow(NotFoundError);
  });
});

describe("Cross-account access — decisions, tasks, comments", () => {
  it("listDecisions returns only the requesting account's decisions for a doc", async () => {
    const docA = await createDocDraft(accountA, "Dec A", "Purpose");
    await createDecision(accountA, docA.id, "Decision in A");

    // Account B asking about doc A's decisions should get nothing (doc not in B's scope)
    const fromBPerspective = await listDecisions(accountB, docA.id);
    expect(fromBPerspective).toEqual([]);

    const fromAPerspective = await listDecisions(accountA, docA.id);
    expect(fromAPerspective).toHaveLength(1);
  });

  it("createTask on a doc from a different account is rejected", async () => {
    const docA = await createDocDraft(accountA, "Task A", "Purpose");
    await expect(
      createTask(accountB, docA.id, "Cross-account task", "Should fail")
    ).rejects.toThrow(NotFoundError);
  });

  it("updateTaskStatus rejects mutations to tasks in another account", async () => {
    const docA = await createDocDraft(accountA, "Update A", "Purpose");
    const task = await createTask(accountA, docA.id, "Mine", "Desc");
    await expect(updateTaskStatus(accountB, task.id, "in_progress")).rejects.toThrow(
      NotFoundError
    );
  });

  it("addComment is rejected when the section belongs to another account's doc", async () => {
    const docA = await createDocDraft(accountA, "Comment A", "Purpose");
    const sectionId = docA.sections[0].id;
    await expect(
      addComment(accountB, sectionId, "Eve", "Cross-account comment")
    ).rejects.toThrow(NotFoundError);
  });

  it("listComments scoped per account — B sees no comments on A's section", async () => {
    const docA = await createDocDraft(accountA, "List Comments A", "Purpose");
    const sectionA = docA.sections[0].id;
    await addComment(accountA, sectionA, "Alice", "Visible to A only");

    const aComments = await listComments(accountA, sectionA);
    const bComments = await listComments(accountB, sectionA);

    expect(aComments).toHaveLength(1);
    expect(bComments).toHaveLength(0);
  });

  it("listTasks for a doc returns empty when called from a different account", async () => {
    const docA = await createDocDraft(accountA, "List Tasks A", "Purpose");
    await createTask(accountA, docA.id, "Hidden", "Desc");

    const aSees = await listTasks(accountA, docA.id);
    const bSees = await listTasks(accountB, docA.id);
    expect(aSees).toHaveLength(1);
    expect(bSees).toHaveLength(0);
  });
});

describe("Cross-account access — sections", () => {
  it("addSection rejects insertion against another account's doc", async () => {
    const docA = await createDocDraft(accountA, "Section A", "Purpose");
    await expect(
      addSection(accountB, docA.id, "approach", "Cross-account body", "Approach")
    ).rejects.toThrow(NotFoundError);
  });

  it("updateSection rejects edits to another account's section", async () => {
    const docA = await createDocDraft(accountA, "Section Update A", "Purpose");
    const sectionId = docA.sections[0].id;
    await expect(updateSection(accountB, sectionId, "tampered")).rejects.toThrow(
      NotFoundError
    );
    // Sanity: same-account update succeeds
    const updated = await updateSection(accountA, sectionId, "Refined");
    expect(updated.content).toBe("Refined");
  });
});
