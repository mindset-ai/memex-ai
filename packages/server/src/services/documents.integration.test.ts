import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections } from "../db/schema.js";
import { createDocDraft, listDocs, getDoc, updateDocStatus, updateDocTitle, archiveDoc, getSpecLineage, promoteToSpec } from "./documents.js";
import { createStandard, flagDrift } from "./standards.js";
import { addComment } from "./comments.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus } from "./bus.js";

// Track IDs created during tests for cleanup
const createdDocIds: string[] = [];

// Only clean up documents created by THIS test run (in afterAll below)

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});


let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("listDocs includeDriftCount — Standards only (b-63)", () => {
  it("counts drift only for Standards, never for non-standard docs", async () => {
    const m = await makeTestMemex();
    // Non-standard doc (spec) with a forced drift comment on its section,
    // bypassing flagDrift's standard-only write guard via addComment.
    const spec = await createDocDraft(m, "Spec with forced drift", "purpose", "spec");
    createdDocIds.push(spec.id);
    await addComment(m, spec.sections[0].id, "Author", "forced drift", { type: "drift" });

    // Standard with a genuine drift.
    const std = await createStandard(m, {
      title: "Std with drift",
      sections: [{ sectionType: "do", content: "Always X." }],
    });
    createdDocIds.push(std.id);
    await flagDrift(m, std.sections[0].id, "drifted");

    const docs = await listDocs(m, { includeDriftCount: true });
    const stdRow = docs.find((d) => d.id === std.id);
    const specRow = docs.find((d) => d.id === spec.id);

    expect(stdRow?.driftCount).toBe(1);
    // The non-standard doc never carries a drift count, even with a forced drift comment.
    expect(specRow?.driftCount).toBeUndefined();
  });
});

describe("createDocDraft", () => {
  it("creates a spec with an overview section by default", async () => {
    const doc = await createDocDraft(memexId, "Integration Test Doc", "Test purpose");
    createdDocIds.push(doc.id);

    expect(doc.title).toBe("Integration Test Doc");
    expect(doc.docType).toBe("spec");
    expect(doc.status).toBe("draft");
    expect(doc.handle).toMatch(/^spec-\d+$/);
    expect(doc.sections).toHaveLength(1);
    // Specs get an "overview" first section per the b-105 shape; non-spec types
    // keep the legacy "purpose" first section.
    expect(doc.sections[0].sectionType).toBe("overview");
    expect(doc.sections[0].content).toBe("Test purpose");
    expect(doc.sections[0].seq).toBe(1);
  });

  it("creates a doc with custom docType", async () => {
    const doc = await createDocDraft(memexId, "My Doc", "Doc purpose", "document");
    createdDocIds.push(doc.id);

    expect(doc.docType).toBe("document");
  });

  it("generates unique sequential handles", async () => {
    const doc1 = await createDocDraft(memexId, "Handle Test 1", "Purpose 1", "document");
    const doc2 = await createDocDraft(memexId, "Handle Test 2", "Purpose 2", "document");
    createdDocIds.push(doc1.id, doc2.id);

    const num1 = parseInt(doc1.handle.split("-")[1]);
    const num2 = parseInt(doc2.handle.split("-")[1]);
    expect(num2).toBe(num1 + 1);
  });

  it("mints `spec-N` handles for specs (b-105)", async () => {
    const spec1 = await createDocDraft(memexId, "Spec A", "Purpose", "spec");
    const spec2 = await createDocDraft(memexId, "Spec B", "Purpose", "spec");
    createdDocIds.push(spec1.id, spec2.id);

    expect(spec1.handle).toMatch(/^spec-\d+$/);
    expect(spec2.handle).toMatch(/^spec-\d+$/);
    const num1 = parseInt(spec1.handle.slice(5));
    const num2 = parseInt(spec2.handle.slice(5));
    expect(num2).toBe(num1 + 1);
  });

  it("keeps `doc-N` handles for non-spec docTypes (b-105)", async () => {
    // Spec and free-form documents share the (memex_id, handle) unique constraint
    // but live in independent numeric sequences (spec-N vs doc-N).
    const doc = await createDocDraft(memexId, "Free doc", "Purpose", "document");
    const plan = await createDocDraft(memexId, "Plan", "Purpose", "execution_plan");
    createdDocIds.push(doc.id, plan.id);

    expect(doc.handle).toMatch(/^doc-\d+$/);
    expect(plan.handle).toMatch(/^doc-\d+$/);
  });
});

describe("listDocs", () => {
  let testDocId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "List Test Doc", "Purpose", "runbook");
    testDocId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("returns all documents with section counts", async () => {
    const docs = await listDocs(memexId, );

    expect(docs.length).toBeGreaterThan(0);
    const testDoc = docs.find((d) => d.id === testDocId);
    expect(testDoc).toBeDefined();
    expect(testDoc!.title).toBe("List Test Doc");
    expect(testDoc!.docType).toBe("runbook");
    expect(testDoc!.sectionCount).toBe(1);
  });

  it("filters by docType", async () => {
    const runbooks = await listDocs(memexId, "runbook");
    expect(runbooks.every((d) => d.docType === "runbook")).toBe(true);

    const testDoc = runbooks.find((d) => d.id === testDocId);
    expect(testDoc).toBeDefined();
  });

  it("returns empty array for non-existent docType", async () => {
    const docs = await listDocs(memexId, "nonexistent_type_xyz");
    expect(docs).toEqual([]);
  });
});

describe("getDoc", () => {
  let testDoc: Awaited<ReturnType<typeof createDocDraft>>;

  beforeAll(async () => {
    testDoc = await createDocDraft(memexId, "Get Test Doc", "Purpose content");
    createdDocIds.push(testDoc.id);
  });

  it("retrieves by UUID", async () => {
    const doc = await getDoc(memexId, testDoc.id);

    expect(doc.id).toBe(testDoc.id);
    expect(doc.title).toBe("Get Test Doc");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].content).toBe("Purpose content");
  });

  it("retrieves by handle", async () => {
    const doc = await getDoc(memexId, testDoc.handle);

    expect(doc.id).toBe(testDoc.id);
    expect(doc.title).toBe("Get Test Doc");
  });

  it("returns sections ordered by seq", async () => {
    await db.insert(docSections).values({
      docId: testDoc.id,
      sectionType: "scope",
      title: "Scope",
      content: "Scope content",
      seq: 2,
      position: 2,
    } as any);

    const doc = await getDoc(memexId, testDoc.id);
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0].seq).toBe(1);
    expect(doc.sections[1].seq).toBe(2);
    expect(doc.sections[1].sectionType).toBe("scope");
  });

  it("throws NotFoundError for non-existent UUID", async () => {
    await expect(
      getDoc(memexId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError for non-existent handle", async () => {
    await expect(getDoc(memexId, "no-such-handle-xyz")).rejects.toThrow(NotFoundError);
  });
});

describe("updateDocStatus", () => {
  it("transitions draft to review and stamps statusChangedAt", async () => {
    const draft = await createDocDraft(memexId, "Status Test", "Purpose");
    createdDocIds.push(draft.id);
    const before = draft.statusChangedAt.getTime();

    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateDocStatus(memexId, draft.id, "review");

    expect(updated.status).toBe("review");
    expect(updated.statusChangedAt.getTime()).toBeGreaterThan(before);
  });

  it("accepts all canonical statuses", async () => {
    // Per dec-3 of doc-10 the column accepts the union of legacy values (review,
    // implementation — still used by non-Spec docTypes) and the new Spec
    // vocabulary (plan, build, verify). 'approved' stays as the execution-plan
    // terminal.
    const draft = await createDocDraft(memexId, "All Statuses", "Purpose");
    createdDocIds.push(draft.id);

    for (const status of [
      "review",
      "implementation",
      "done",
      "approved",
      "plan",
      "build",
      "verify",
      "draft",
    ] as const) {
      const updated = await updateDocStatus(memexId, draft.id, status);
      expect(updated.status).toBe(status);
    }
  });

  it("allows agent to move verify→done at the service layer (doc-12 dec-6: soft guidance, not hard block)", async () => {
    // Per dec-6 of doc-12 the service layer no longer rejects agent verify→done.
    // The agent surface (MCP `update_doc_status` / `publish_brief` and the
    // chat-agent tools layer) emits a strong dec-3 warning when no recent
    // assess_phase_transition has run, but the call itself succeeds. Keeping
    // policy in the surface layer (where the warning text lives) instead of
    // the service keeps the React UI / REST flows unaffected.
    const spec = await createDocDraft(memexId, "Spec Close", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await updateDocStatus(memexId, spec.id, "verify");

    const closed = await updateDocStatus(memexId, spec.id, "done", { source: "agent" });
    expect(closed.status).toBe("done");
  });

  it("allows agent transitions other than verify→done", async () => {
    const spec = await createDocDraft(memexId, "Spec Build", "Purpose", "spec");
    createdDocIds.push(spec.id);
    // Agent can drive draft→plan→build→verify.
    await updateDocStatus(memexId, spec.id, "plan", { source: "agent" });
    await updateDocStatus(memexId, spec.id, "build", { source: "agent" });
    const verified = await updateDocStatus(memexId, spec.id, "verify", { source: "agent" });
    expect(verified.status).toBe("verify");
  });

  it("transitions a plan-doc-shaped flow into 'approved' (t-20 W-B)", async () => {
    // Mirrors the t-17 ExecutionPlanModal approve flow: a plan doc moves
    // draft → review → implementation → approved (the new terminal state added
    // by 0027_v2_deferral_fixes.sql, distinct from generic 'done').
    const plan = await createDocDraft(memexId, "Plan", "Purpose", "execution_plan");
    createdDocIds.push(plan.id);

    await updateDocStatus(memexId, plan.id, "review");
    await updateDocStatus(memexId, plan.id, "implementation");
    const approved = await updateDocStatus(memexId, plan.id, "approved");

    expect(approved.status).toBe("approved");
  });

  it("throws ValidationError for invalid status", async () => {
    const draft = await createDocDraft(memexId, "Invalid Status", "Purpose");
    createdDocIds.push(draft.id);

    await expect(updateDocStatus(memexId, draft.id, "active")).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError for non-existent id", async () => {
    await expect(
      updateDocStatus(memexId, "00000000-0000-0000-0000-000000000000", "review")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("updateDocTitle", () => {
  it("updates the title and returns the new row", async () => {
    const draft = await createDocDraft(memexId, "Original Title", "Purpose");
    createdDocIds.push(draft.id);

    const updated = await updateDocTitle(memexId, draft.id, "Renamed Title");
    expect(updated.title).toBe("Renamed Title");

    const refetched = await getDoc(memexId, draft.id);
    expect(refetched.title).toBe("Renamed Title");
  });

  it("trims whitespace", async () => {
    const draft = await createDocDraft(memexId, "Trimmer", "Purpose");
    createdDocIds.push(draft.id);

    const updated = await updateDocTitle(memexId, draft.id, "   Padded   ");
    expect(updated.title).toBe("Padded");
  });

  it("rejects empty titles", async () => {
    const draft = await createDocDraft(memexId, "Empty Title Test", "Purpose");
    createdDocIds.push(draft.id);

    await expect(updateDocTitle(memexId, draft.id, "   ")).rejects.toThrow(ValidationError);
    await expect(updateDocTitle(memexId, draft.id, "")).rejects.toThrow(ValidationError);
  });

  it("rejects titles longer than 500 characters", async () => {
    const draft = await createDocDraft(memexId, "Long Title Test", "Purpose");
    createdDocIds.push(draft.id);

    await expect(updateDocTitle(memexId, draft.id, "x".repeat(501))).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError for non-existent id", async () => {
    await expect(
      updateDocTitle(memexId, "00000000-0000-0000-0000-000000000000", "New Title")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("archiveDoc", () => {
  it("stamps archivedAt and hides the doc from listDocs / getDoc", async () => {
    const draft = await createDocDraft(memexId, "To Archive", "Purpose");
    createdDocIds.push(draft.id);

    const before = await listDocs(memexId);
    expect(before.some((d) => d.id === draft.id)).toBe(true);

    const archived = await archiveDoc(memexId, draft.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);

    const after = await listDocs(memexId);
    expect(after.some((d) => d.id === draft.id)).toBe(false);

    await expect(getDoc(memexId, draft.id)).rejects.toThrow(NotFoundError);
  });

  it("includeArchived:true surfaces archived docs", async () => {
    const draft = await createDocDraft(memexId, "Findable When Archived", "Purpose");
    createdDocIds.push(draft.id);

    await archiveDoc(memexId, draft.id);

    const list = await listDocs(memexId, { includeArchived: true });
    expect(list.some((d) => d.id === draft.id)).toBe(true);

    const fetched = await getDoc(memexId, draft.id, { includeArchived: true });
    expect(fetched.id).toBe(draft.id);
    expect(fetched.archivedAt).toBeInstanceOf(Date);
  });

  it("is idempotent — second archive keeps the original timestamp", async () => {
    const draft = await createDocDraft(memexId, "Double Archive", "Purpose");
    createdDocIds.push(draft.id);

    const first = await archiveDoc(memexId, draft.id);
    const firstTs = first.archivedAt!.getTime();

    await new Promise((r) => setTimeout(r, 5));
    const second = await archiveDoc(memexId, draft.id);
    expect(second.archivedAt!.getTime()).toBe(firstTs);
  });

  it("throws NotFoundError for non-existent id", async () => {
    await expect(
      archiveDoc(memexId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });
});

// ── Spec lineage (t-2) ───────────────────────────────────
// Lineage is a parent_doc_id chain on `documents`. listDocs / getDoc must surface the
// FK so the React UI can render the breadcrumb without a second round-trip.
// promoteToSpec is the only blessed way to set parent_doc_id from the service layer
// (writes directly to schema also work, but we want the path the agent + MCP take).

describe("spec lineage / parentDocId", () => {
  it("listDocs and getDoc surface parentDocId", async () => {
    const root = await createDocDraft(memexId, "Lineage root", "Purpose");
    createdDocIds.push(root.id);
    const child = await promoteToSpec(memexId, root.id, "Lineage child");
    createdDocIds.push(child.id);

    const list = await listDocs(memexId);
    const childRow = list.find((d) => d.id === child.id);
    const rootRow = list.find((d) => d.id === root.id);
    expect(childRow).toBeDefined();
    expect(childRow!.parentDocId).toBe(root.id);
    expect(rootRow!.parentDocId).toBeNull();

    const fetched = await getDoc(memexId, child.id);
    expect(fetched.parentDocId).toBe(root.id);
  });

  it("listDocs filters by docType='spec'", async () => {
    const a = await createDocDraft(memexId, "Spec A", "P", "spec");
    const b = await createDocDraft(memexId, "Doc B", "P", "document");
    createdDocIds.push(a.id, b.id);

    const specs = await listDocs(memexId, "spec");
    expect(specs.some((d) => d.id === a.id)).toBe(true);
    expect(specs.some((d) => d.id === b.id)).toBe(false);
    expect(specs.every((d) => d.docType === "spec")).toBe(true);
  });

  it("promoteToSpec creates a spec doc with parent_doc_id set", async () => {
    const source = await createDocDraft(memexId, "Source", "Purpose");
    createdDocIds.push(source.id);

    const promoted = await promoteToSpec(memexId, source.id, "Promoted spec");
    createdDocIds.push(promoted.id);

    expect(promoted.parentDocId).toBe(source.id);
    expect(promoted.docType).toBe("spec");
    expect(promoted.title).toBe("Promoted spec");
    expect(promoted.sections.length).toBeGreaterThan(0);
  });

  it("promoteToSpec throws on missing source", async () => {
    await expect(
      promoteToSpec(memexId, "00000000-0000-0000-0000-000000000000", "x"),
    ).rejects.toThrow(NotFoundError);
  });

  it("promoteToSpec rejects empty titles", async () => {
    const source = await createDocDraft(memexId, "Source 2", "Purpose");
    createdDocIds.push(source.id);
    await expect(promoteToSpec(memexId, source.id, "   ")).rejects.toThrow(
      ValidationError,
    );
  });

  it("getSpecLineage walks deeply, ordered root→leaf, including self", async () => {
    const a = await createDocDraft(memexId, "L1 A", "P");
    createdDocIds.push(a.id);
    const b = await promoteToSpec(memexId, a.id, "L2 B");
    createdDocIds.push(b.id);
    const c = await promoteToSpec(memexId, b.id, "L3 C");
    createdDocIds.push(c.id);
    const d = await promoteToSpec(memexId, c.id, "L4 D");
    createdDocIds.push(d.id);

    const chain = await getSpecLineage(memexId, d.id);
    expect(chain.map((doc) => doc.id)).toEqual([a.id, b.id, c.id, d.id]);
  });

  it("getSpecLineage returns just the doc when no parent", async () => {
    const root = await createDocDraft(memexId, "Solo root", "P");
    createdDocIds.push(root.id);
    const chain = await getSpecLineage(memexId, root.id);
    expect(chain).toHaveLength(1);
    expect(chain[0].id).toBe(root.id);
  });

  it("getSpecLineage is cycle-safe", async () => {
    // Manufacture a cycle directly via SQL: a → b → a. The service-layer promote API
    // can't reach this state, but a corrupted edge from a future migration / manual fix
    // shouldn't hang the lineage walk.
    const a = await createDocDraft(memexId, "Cycle A", "P");
    createdDocIds.push(a.id);
    const b = await createDocDraft(memexId, "Cycle B", "P");
    createdDocIds.push(b.id);

    await db.update(documents).set({ parentDocId: a.id }).where(eq(documents.id, b.id));
    await db.update(documents).set({ parentDocId: b.id }).where(eq(documents.id, a.id));

    const chain = await getSpecLineage(memexId, b.id);
    // The walk terminates on cycle detection rather than looping forever; the chain
    // contains both ids exactly once, ordered root→leaf as encountered.
    expect(chain.map((d: { id: string }) => d.id)).toEqual([a.id, b.id]);
    const ids = chain.map((d: { id: string }) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getSpecLineage isolates across memexes", async () => {
    const otherAccount = await makeTestMemex("other");
    const otherRoot = await createDocDraft(otherAccount, "Other root", "P");
    const myChild = await createDocDraft(memexId, "My child", "P");
    createdDocIds.push(myChild.id);

    // Wire myChild.parent_doc_id at a doc that lives in a different account. The walk
    // must NOT cross the tenancy boundary.
    await db
      .update(documents)
      .set({ parentDocId: otherRoot.id })
      .where(eq(documents.id, myChild.id));

    const chain = await getSpecLineage(memexId, myChild.id);
    expect(chain).toHaveLength(1);
    expect(chain[0].id).toBe(myChild.id);

    // Calling lineage on the other-account doc from this account 404s — never leaks.
    await expect(getSpecLineage(memexId, otherRoot.id)).rejects.toThrow(NotFoundError);

    // Cleanup: drop the cross-account row plus the otherAccount.
    await db.delete(documents).where(eq(documents.id, otherRoot.id));
  });

  it("emits doc-change events on promotion", async () => {
    const source = await createDocDraft(memexId, "Emit source", "P");
    createdDocIds.push(source.id);

    const seen: { docId: string | undefined; entity: string; action: string }[] = [];
    const unsubscribe = bus.subscribe({ memexId }, (e) =>
      seen.push({ docId: e.docId, entity: e.entity, action: e.action }),
    );
    try {
      const child = await promoteToSpec(memexId, source.id, "Emit child");
      createdDocIds.push(child.id);
      const childEvents = seen.filter((e) => e.docId === child.id);
      // createDocDraft fires a "created"; promote follows up with "updated" once the
      // parent_doc_id link is wired.
      expect(childEvents.some((e) => e.entity === "document" && e.action === "created")).toBe(
        true,
      );
      expect(childEvents.some((e) => e.entity === "document" && e.action === "updated")).toBe(
        true,
      );
    } finally {
      unsubscribe();
    }
  });
});
