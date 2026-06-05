// Regression test for doc-37: getTaskByHandle silently picked a row when the
// bare T-N handle matched tasks in multiple docs in the same memex. The fix:
// throw AmbiguousTaskHandleError, matching getDecisionByHandle's behaviour.
// Also covers the new optional parentDocId arg that scopes the lookup to one
// doc — wired through resolveRef in mcp/tool-specs.ts.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, tasks } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  createTask,
  getTaskByHandle,
  AmbiguousTaskHandleError,
} from "./tasks.js";
import { NotFoundError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length === 0) return;
  await db.delete(tasks).where(inArray(tasks.docId, createdDocIds)).catch(() => {});
  await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
});

describe("getTaskByHandle — cross-Spec ambiguity (doc-37)", () => {
  let memexId: string;
  beforeAll(async () => {
    memexId = await makeTestMemex();
  });

  it("throws AmbiguousTaskHandleError when T-N exists in multiple docs in the memex", async () => {
    const docA = await createDocDraft(memexId, "Ambiguity Doc A", "Purpose");
    const docB = await createDocDraft(memexId, "Ambiguity Doc B", "Purpose");
    createdDocIds.push(docA.id, docB.id);

    const tA = await createTask(memexId, docA.id, "Task in A", "Desc");
    const tB = await createTask(memexId, docB.id, "Task in B", "Desc");
    // Both should be T-1 (per-doc seq).
    expect(tA.seq).toBe(1);
    expect(tB.seq).toBe(1);

    await expect(getTaskByHandle(memexId, "T-1")).rejects.toThrow(
      AmbiguousTaskHandleError,
    );
  });

  it("AmbiguousTaskHandleError carries the candidate qualified handles", async () => {
    const docA = await createDocDraft(memexId, "Candidates Doc A", "Purpose");
    const docB = await createDocDraft(memexId, "Candidates Doc B", "Purpose");
    createdDocIds.push(docA.id, docB.id);

    await createTask(memexId, docA.id, "Task in A", "Desc");
    await createTask(memexId, docB.id, "Task in B", "Desc");

    try {
      await getTaskByHandle(memexId, "T-1");
      throw new Error("expected AmbiguousTaskHandleError");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousTaskHandleError);
      const candidates = (err as AmbiguousTaskHandleError).candidates;
      expect(candidates.length).toBeGreaterThanOrEqual(2);
      // Each candidate should look like `<docHandle>:T-1`. createDocDraft
      // defaults to docType="spec" (b-105), so docs get spec-N handles.
      for (const c of candidates) {
        expect(c).toMatch(/^spec-\d+:T-1$/);
      }
    }
  });

  it("resolves the correct task when parentDocId scopes the lookup", async () => {
    const docA = await createDocDraft(memexId, "Parent A", "Purpose");
    const docB = await createDocDraft(memexId, "Parent B", "Purpose");
    createdDocIds.push(docA.id, docB.id);

    const tA = await createTask(memexId, docA.id, "Task in A", "Desc");
    const tB = await createTask(memexId, docB.id, "Task in B", "Desc");

    const foundA = await getTaskByHandle(memexId, "T-1", docA.id);
    const foundB = await getTaskByHandle(memexId, "T-1", docB.id);

    expect(foundA.id).toBe(tA.id);
    expect(foundB.id).toBe(tB.id);
  });

  it("resolves unambiguously when T-N exists in only one doc in the memex", async () => {
    const isolated = await makeTestMemex();
    const doc = await createDocDraft(isolated, "Sole Doc", "Purpose");
    createdDocIds.push(doc.id);
    const t = await createTask(isolated, doc.id, "Sole task", "Desc");
    expect(t.seq).toBe(1);

    const found = await getTaskByHandle(isolated, "T-1");
    expect(found.id).toBe(t.id);
  });

  it("throws NotFoundError when no task matches the handle in the memex", async () => {
    const isolated = await makeTestMemex();
    await expect(getTaskByHandle(isolated, "T-99")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("throws NotFoundError when parentDocId scopes to a doc with no matching task", async () => {
    const docA = await createDocDraft(memexId, "Empty Parent Doc", "Purpose");
    const docB = await createDocDraft(memexId, "Task Owner Doc", "Purpose");
    createdDocIds.push(docA.id, docB.id);

    // T-1 exists in docB but not docA. Looking up via parentDocId=docA must fail.
    await createTask(memexId, docB.id, "Task in B", "Desc");

    await expect(getTaskByHandle(memexId, "T-1", docA.id)).rejects.toThrow(
      NotFoundError,
    );
  });
});
