// spec-529 t-2 — the handle filter and the task-progress projection, against a real
// database. The route test proves the wiring; this proves the query.
//
// The load-bearing claim is the LAST test: the pill's fraction and the Spec page's
// own task list must be computed from one source. A pill reading `1/3` beside a page
// reading `2/3` would discredit the feature more thoroughly than no pill at all.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft, listDocs, MAX_HANDLE_FILTER } from "./documents.js";
import { createTask, updateTaskStatus, listTasks } from "./tasks.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});

let memexId: string;
let specA: { id: string; handle: string };
let specB: { id: string; handle: string };
let specC: { id: string; handle: string };

beforeAll(async () => {
  memexId = await makeTestMemex();
  const a = await createDocDraft(memexId, "Referenced spec A", "purpose", "spec");
  const b = await createDocDraft(memexId, "Referenced spec B", "purpose", "spec");
  const c = await createDocDraft(memexId, "Unreferenced spec C", "purpose", "spec");
  for (const d of [a, b, c]) createdDocIds.push(d.id);
  specA = { id: a.id, handle: a.handle };
  specB = { id: b.id, handle: b.handle };
  specC = { id: c.id, handle: c.handle };

  // Spec A: three tasks, one complete, one in progress, one untouched.
  const t1 = await createTask(memexId, specA.id, "one", "d");
  const t2 = await createTask(memexId, specA.id, "two", "d");
  await createTask(memexId, specA.id, "three", "d");
  await updateTaskStatus(memexId, t1.id, "complete");
  await updateTaskStatus(memexId, t2.id, "in_progress");
  // Spec B deliberately has NO tasks.
});

describe("listDocs handle filter (spec-529)", () => {
  it("returns exactly the named Specs and nothing else", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-529/acs/ac-10");
    const rows = await listDocs(memexId, { handles: [specA.handle, specB.handle] });
    expect(rows.map((r) => r.handle).sort()).toEqual(
      [specA.handle, specB.handle].sort(),
    );
    expect(rows.map((r) => r.handle)).not.toContain(specC.handle);
  });

  it("returns nothing for a handle that names nothing — the same answer an unreadable one gets", async () => {
    // std-7: absent and forbidden must be indistinguishable from the outside.
    const rows = await listDocs(memexId, { handles: ["spec-99999"] });
    expect(rows).toEqual([]);
  });

  it("returns nothing for an empty handle set rather than the whole Memex", async () => {
    const rows = await listDocs(memexId, { handles: [] });
    expect(rows).toEqual([]);
  });

  it("caps an oversized handle set instead of issuing an unbounded query", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-529/acs/ac-11");
    // Pad far past the cap, with the one real handle pushed beyond it. The result
    // proves the tail was dropped rather than queried.
    const padding = Array.from({ length: MAX_HANDLE_FILTER }, (_, i) => `spec-${90000 + i}`);
    const rows = await listDocs(memexId, { handles: [...padding, specA.handle] });
    expect(rows).toEqual([]);

    // Inside the cap, the same handle resolves.
    const within = await listDocs(memexId, { handles: [specA.handle, ...padding.slice(0, 5)] });
    expect(within.map((r) => r.handle)).toEqual([specA.handle]);
  });
});

describe("listDocs includeTaskProgress (spec-529)", () => {
  it("splits tasks by status, and omits the field entirely for a Spec with none", async () => {
    const rows = await listDocs(memexId, {
      handles: [specA.handle, specB.handle],
      includeTaskProgress: true,
    });
    const a = rows.find((r) => r.handle === specA.handle);
    const b = rows.find((r) => r.handle === specB.handle);

    expect(a?.taskProgress).toEqual({
      total: 3,
      complete: 1,
      inProgress: 1,
      notStarted: 1,
    });
    // Absence is the signal — the pill renders no fraction, never `0/0`.
    expect(b?.taskProgress).toBeUndefined();
  });

  it("is off unless asked for", async () => {
    const rows = await listDocs(memexId, { handles: [specA.handle] });
    expect(rows[0]?.taskProgress).toBeUndefined();
  });

  it("agrees with the Spec page's own task list — one source, not two counts", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-529/acs/ac-10");
    const [row] = await listDocs(memexId, {
      handles: [specA.handle],
      includeTaskProgress: true,
    });
    const pageTasks = await listTasks(memexId, specA.id);

    expect(row.taskProgress?.total).toBe(pageTasks.length);
    expect(row.taskProgress?.complete).toBe(
      pageTasks.filter((t) => t.status === "complete").length,
    );
    expect(row.taskProgress?.inProgress).toBe(
      pageTasks.filter((t) => t.status === "in_progress").length,
    );
    expect(row.taskProgress?.notStarted).toBe(
      pageTasks.filter((t) => t.status === "not_started").length,
    );
  });
});
