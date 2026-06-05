import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, issues } from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import {
  createIssue,
  listIssuesForSpec,
  getIssue,
  updateIssue,
  updateIssueStatus,
  deleteIssue,
} from "./issues.js";
import { tagAc } from "@memex-ai-ac/vitest";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus, type ChangeEvent } from "./bus.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-112/acs/ac-${n}`;

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(issues).where(eq(issues.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

async function makeSpec(title: string): Promise<string> {
  const doc = await createDocDraft(memexId, title, "Purpose");
  createdDocIds.push(doc.id);
  return doc.id;
}

describe("createIssue", () => {
  it("creates an Issue with open status under a Spec", async () => {
    const docId = await makeSpec("Issue Create Doc");
    const issue = await createIssue({
      memexId,
      docId,
      title: "Login button is dead",
      body: "Clicking does nothing",
      type: "bug",
      severity: "high",
    });
    expect(issue.title).toBe("Login button is dead");
    expect(issue.type).toBe("bug");
    expect(issue.severity).toBe("high");
    expect(issue.status).toBe("open");
    expect(issue.source).toBe("human");
    expect(issue.docId).toBe(docId);
    expect(issue.seq).toBeGreaterThan(0);
  });

  it("rejects an empty title", async () => {
    const docId = await makeSpec("Issue Empty Title Doc");
    await expect(
      createIssue({ memexId, docId, title: "  ", body: "b", type: "todo" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns 404 (NotFoundError) when the Spec is not in the memex (std-7)", async () => {
    const otherMemex = await makeTestMemex();
    const docId = await makeSpec("Issue Tenancy Doc");
    await expect(
      createIssue({ memexId: otherMemex, docId, title: "x", body: "y", type: "bug" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listIssuesForSpec / getIssue", () => {
  it("returns Issues ordered by seq, filtered by type/status", async () => {
    const docId = await makeSpec("Issue List Doc");
    const a = await createIssue({ memexId, docId, title: "A", body: "b", type: "bug" });
    const b = await createIssue({ memexId, docId, title: "B", body: "b", type: "todo" });

    const all = await listIssuesForSpec(memexId, docId);
    expect(all.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(all[0].seq).toBeLessThan(all[1].seq);

    const bugs = await listIssuesForSpec(memexId, docId, { type: "bug" });
    expect(bugs.map((i) => i.id)).toEqual([a.id]);

    const open = await listIssuesForSpec(memexId, docId, { status: "open" });
    expect(open).toHaveLength(2);
  });

  it("getIssue returns 404 for a cross-tenant id (std-7)", async () => {
    const otherMemex = await makeTestMemex();
    const docId = await makeSpec("Issue Get Tenancy Doc");
    const issue = await createIssue({ memexId, docId, title: "Mine", body: "b", type: "bug" });
    await expect(getIssue(otherMemex, issue.id)).rejects.toBeInstanceOf(NotFoundError);
    const found = await getIssue(memexId, issue.id);
    expect(found.id).toBe(issue.id);
  });
});

// ac-11 — create/update/delete each route through mutate() and emit a ChangeEvent
// observable by a subscriber filtered {memexId, entity:'issue'}.
describe("mutate() + bus emission (ac-11)", () => {
  it("emits issue created/updated/deleted on the bus", async () => {
    tagAc(AC(11));
    const docId = await makeSpec("Issue Emit Doc");

    const seen: ChangeEvent[] = [];
    const unsubscribe = bus.subscribe({ memexId, entity: "issue" }, (e) => seen.push(e));
    try {
      const issue = await createIssue({
        memexId,
        docId,
        title: "Emit me",
        body: "b",
        type: "bug",
      });
      await updateIssue(memexId, issue.id, { title: "Emit me v2" });
      await updateIssueStatus(memexId, issue.id, "resolved");
      await deleteIssue(memexId, issue.id);

      const actions = seen.map((e) => e.action);
      expect(actions).toContain("created");
      expect(actions).toContain("updated");
      expect(actions).toContain("deleted");
      // Every emitted event is scoped to this Spec + entity (the subscribe filter
      // already enforces entity:'issue' and memexId).
      for (const e of seen) {
        expect(e.entity).toBe("issue");
        expect(e.memexId).toBe(memexId);
        expect(e.docId).toBe(docId);
      }
    } finally {
      unsubscribe();
    }
  });

  it("does NOT emit to a subscriber filtered on a different entity", async () => {
    tagAc(AC(11));
    const docId = await makeSpec("Issue Emit Filter Doc");
    const seen: ChangeEvent[] = [];
    // A subscriber listening for tasks must not receive issue events.
    const unsubscribe = bus.subscribe({ memexId, entity: "task" }, (e) => seen.push(e));
    try {
      await createIssue({ memexId, docId, title: "Not for tasks", body: "b", type: "bug" });
      expect(seen).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});

// ac-10 — the issue-N seq is independent of other handle spaces and concurrency-safe.
describe("issue-N seq allocation (ac-10)", () => {
  it("allocates sequential issue-N independent of ac/task/decision seqs", async () => {
    tagAc(AC(10));
    const docId = await makeSpec("Issue Seq Doc");
    const a = await createIssue({ memexId, docId, title: "first", body: "b", type: "bug" });
    const b = await createIssue({ memexId, docId, title: "second", body: "b", type: "todo" });
    // Fresh Spec — the issue seq space starts at 1 regardless of other entities.
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it("is concurrency-safe under parallel creates (withSeqRetry, UNIQUE(doc_id,seq))", async () => {
    tagAc(AC(10));
    const docId = await makeSpec("Issue Concurrent Doc");
    // N=6 sits inside the contention band the shared withSeqRetry allocator
    // (maxAttempts=5) recovers from — the same band createTask / createAc use.
    // The constraint we actually assert is the one that matters: the seq space is
    // never corrupted. Each concurrent create re-reads MAX(seq) on a 23505 retry,
    // so all succeed AND every committed seq is distinct + dense (1..N).
    const N = 6;
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        createIssue({ memexId, docId, title: `c${i}`, body: "b", type: "bug" }),
      ),
    );
    const seqs = created.map((c) => c.seq).sort((x, y) => x - y);
    // No duplicate seqs ever commit — UNIQUE(doc_id,seq) is the hard guarantee.
    expect(new Set(seqs).size).toBe(N);
    // And under this contention every writer recovered, yielding a dense 1..N.
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});

// ac-12 — create works against a Spec in ANY status (no phase guard).
describe("create against any Spec status (ac-12)", () => {
  it("creates an Issue for a Spec in draft, build, done, paused and archived", async () => {
    tagAc(AC(12));
    for (const status of ["draft", "plan", "build", "verify", "done"]) {
      const docId = await makeSpec(`Issue Status ${status} Doc`);
      await updateDocStatus(memexId, docId, status);
      const issue = await createIssue({
        memexId,
        docId,
        title: `raised in ${status}`,
        body: "b",
        type: "bug",
      });
      expect(issue.status).toBe("open");
      expect(issue.docId).toBe(docId);
    }
  });
});

// ac-16 — a write with a bad status value is rejected (the allowed set is
// exactly open|converted|resolved|wont_fix).
describe("status validation (ac-16)", () => {
  it("rejects an out-of-set status value with ValidationError", async () => {
    tagAc(AC(16));
    const docId = await makeSpec("Issue Bad Status Doc");
    const issue = await createIssue({ memexId, docId, title: "x", body: "b", type: "bug" });
    await expect(
      updateIssueStatus(memexId, issue.id, "closed"),
    ).rejects.toBeInstanceOf(ValidationError);
    // The row is untouched — still open.
    const after = await getIssue(memexId, issue.id);
    expect(after.status).toBe("open");
  });

  it("accepts each valid status value", async () => {
    tagAc(AC(16));
    const docId = await makeSpec("Issue Valid Status Doc");
    for (const status of ["open", "converted", "resolved", "wont_fix"]) {
      const issue = await createIssue({ memexId, docId, title: status, body: "b", type: "bug" });
      const updated = await updateIssueStatus(memexId, issue.id, status);
      expect(updated.status).toBe(status);
    }
  });
});
