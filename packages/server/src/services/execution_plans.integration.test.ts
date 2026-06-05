import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, tasks } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createTask } from "./tasks.js";
import {
  createExecutionPlan,
  getExecutionPlanForTask,
  listDependentExecutionPlans,
  clearExecutionPlanLink,
  EXECUTION_PLAN_SECTION_TYPES,
} from "./execution_plans.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { bus } from "./bus.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("createExecutionPlan", () => {
  it("creates an execution_plan doc with the four standardised sections, links task", async () => {
    const spec = await createDocDraft(memexId, "Spec A", "Purpose");
    createdDocIds.push(spec.id);
    const item = await createTask(memexId, spec.id, "Wire OAuth", "Description");

    const plan = await createExecutionPlan(memexId, item.id);
    createdDocIds.push(plan.id);

    expect(plan.docType).toBe("execution_plan");
    expect(plan.status).toBe("draft");
    expect(plan.title).toBe("Execution plan for Wire OAuth");

    expect(plan.sections.map((s) => s.sectionType)).toEqual([...EXECUTION_PLAN_SECTION_TYPES]);
    expect(plan.sections.every((s) => s.content === "")).toBe(true);
    expect(plan.sections.map((s) => s.seq)).toEqual([1, 2, 3, 4]);

    // FK is wired on the task per dec-6 (NOT a self-FK on documents).
    const refreshed = await db.query.tasks.findFirst({
      where: eq(tasks.id, item.id),
    });
    expect(refreshed?.executionPlanDocId).toBe(plan.id);
  });

  it("accepts initial section content overrides", async () => {
    const spec = await createDocDraft(memexId, "Spec B", "Purpose");
    createdDocIds.push(spec.id);
    const item = await createTask(memexId, spec.id, "Add caching", "Description");

    const plan = await createExecutionPlan(memexId, item.id, {
      title: "Custom title",
      sections: {
        files_modified: "- src/cache.ts\n- src/index.ts",
        narrative: "Background and rationale go here.",
      },
    });
    createdDocIds.push(plan.id);

    expect(plan.title).toBe("Custom title");
    const fm = plan.sections.find((s) => s.sectionType === "files_modified");
    const narrative = plan.sections.find((s) => s.sectionType === "narrative");
    const conflicts = plan.sections.find((s) => s.sectionType === "conflicts");
    expect(fm?.content).toContain("src/cache.ts");
    expect(narrative?.content).toContain("Background");
    // Sections without an override still get inserted, with empty content.
    expect(conflicts?.content).toBe("");
  });

  it("throws ValidationError if the task already has a linked plan", async () => {
    const spec = await createDocDraft(memexId, "Spec C", "Purpose");
    createdDocIds.push(spec.id);
    const item = await createTask(memexId, spec.id, "Already linked", "Description");
    const plan = await createExecutionPlan(memexId, item.id);
    createdDocIds.push(plan.id);

    await expect(createExecutionPlan(memexId, item.id)).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError for a missing task", async () => {
    await expect(
      createExecutionPlan(memexId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundError);
  });

  it("isolates across memexes (task belongs to a different account)", async () => {
    const otherAccount = await makeTestMemex("ep-other");
    const otherSpec = await createDocDraft(otherAccount, "Other spec", "Purpose");
    const otherItem = await createTask(
      otherAccount,
      otherSpec.id,
      "Foreign work",
      "Description",
    );
    await expect(createExecutionPlan(memexId, otherItem.id)).rejects.toThrow(NotFoundError);
    await db.delete(documents).where(eq(documents.id, otherSpec.id));
  });
});

describe("getExecutionPlanForTask", () => {
  it("returns the linked plan with sections", async () => {
    const spec = await createDocDraft(memexId, "Spec D", "Purpose");
    createdDocIds.push(spec.id);
    const item = await createTask(memexId, spec.id, "Investigate", "Description");
    const plan = await createExecutionPlan(memexId, item.id);
    createdDocIds.push(plan.id);

    const fetched = await getExecutionPlanForTask(memexId, item.id);
    expect(fetched?.id).toBe(plan.id);
    expect(fetched?.sections).toHaveLength(4);
    expect(fetched?.sections.map((s) => s.sectionType)).toEqual([
      ...EXECUTION_PLAN_SECTION_TYPES,
    ]);
  });

  it("returns null when the task has no plan", async () => {
    const spec = await createDocDraft(memexId, "Spec E", "Purpose");
    createdDocIds.push(spec.id);
    const item = await createTask(memexId, spec.id, "Bare", "Description");

    const fetched = await getExecutionPlanForTask(memexId, item.id);
    expect(fetched).toBeNull();
  });

  it("throws NotFoundError when the task itself is missing/cross-account", async () => {
    await expect(
      getExecutionPlanForTask(memexId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("listDependentExecutionPlans", () => {
  it("returns plans linked to tasks inside a spec", async () => {
    const spec = await createDocDraft(memexId, "Spec with plans", "Purpose");
    createdDocIds.push(spec.id);

    const t1 = await createTask(memexId, spec.id, "T1", "Description");
    const t2 = await createTask(memexId, spec.id, "T2", "Description");
    await createTask(memexId, spec.id, "T3 (no plan)", "Description");

    const p1 = await createExecutionPlan(memexId, t1.id);
    createdDocIds.push(p1.id);
    const p2 = await createExecutionPlan(memexId, t2.id);
    createdDocIds.push(p2.id);

    const plans = await listDependentExecutionPlans(memexId, spec.id);
    const ids = plans.map((p) => p.id).sort();
    expect(ids).toEqual([p1.id, p2.id].sort());
    expect(plans.every((p) => p.docType === "execution_plan")).toBe(true);
    // Sections are returned with each plan, ordered by seq.
    expect(plans[0].sections.length).toBe(4);
  });

  it("returns empty when no tasks have plans yet", async () => {
    const spec = await createDocDraft(memexId, "Empty plans spec", "Purpose");
    createdDocIds.push(spec.id);
    await createTask(memexId, spec.id, "Standalone", "Description");

    const plans = await listDependentExecutionPlans(memexId, spec.id);
    expect(plans).toEqual([]);
  });

  it("throws NotFoundError for a missing/cross-account spec", async () => {
    await expect(
      listDependentExecutionPlans(memexId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("clearExecutionPlanLink + relink", () => {
  it("can drop the FK and create a new plan for the same task", async () => {
    const spec = await createDocDraft(memexId, "Relink spec", "Purpose");
    createdDocIds.push(spec.id);
    const item = await createTask(memexId, spec.id, "Relink WI", "Description");

    const first = await createExecutionPlan(memexId, item.id);
    createdDocIds.push(first.id);

    await clearExecutionPlanLink(memexId, item.id);
    const cleared = await db.query.tasks.findFirst({ where: eq(tasks.id, item.id) });
    expect(cleared?.executionPlanDocId).toBeNull();

    const second = await createExecutionPlan(memexId, item.id, { title: "Second pass" });
    createdDocIds.push(second.id);
    expect(second.id).not.toBe(first.id);
    expect(second.title).toBe("Second pass");

    const refreshed = await db.query.tasks.findFirst({ where: eq(tasks.id, item.id) });
    expect(refreshed?.executionPlanDocId).toBe(second.id);

    // The old plan doc still exists (not deleted) so its review history is preserved.
    const firstStill = await db.query.documents.findFirst({ where: eq(documents.id, first.id) });
    expect(firstStill).toBeDefined();
  });

  it("clearExecutionPlanLink is a no-op when no plan is linked", async () => {
    const spec = await createDocDraft(memexId, "No-op clear", "Purpose");
    createdDocIds.push(spec.id);
    const item = await createTask(memexId, spec.id, "Bare", "Description");
    await expect(clearExecutionPlanLink(memexId, item.id)).resolves.toBeUndefined();
  });
});

describe("doc-change events", () => {
  it("emits document/created and task/updated when a plan is created", async () => {
    const spec = await createDocDraft(memexId, "Events spec", "Purpose");
    createdDocIds.push(spec.id);
    const item = await createTask(memexId, spec.id, "Event WI", "Description");

    const seen: { docId: string | undefined; entity: string; action: string }[] = [];
    const unsubscribe = bus.subscribe({ memexId }, (e) =>
      seen.push({ docId: e.docId, entity: e.entity, action: e.action }),
    );
    try {
      const plan = await createExecutionPlan(memexId, item.id);
      createdDocIds.push(plan.id);
      expect(
        seen.some(
          (e) => e.docId === plan.id && e.entity === "document" && e.action === "created",
        ),
      ).toBe(true);
      expect(
        seen.some(
          (e) => e.docId === spec.id && e.entity === "task" && e.action === "updated",
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
