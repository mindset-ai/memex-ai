import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTestAppWithTenant, passthroughMiddleware } from "./route-test-helpers.js";
import { testMutate } from "../services/__test__/mutate-helpers.js";

// Mock session middleware (t-13) so the route's `.use()` is a pass-through and the stubbed
// currentAccount/user from `makeTestAppWithTenant` reach the handler intact.
vi.mock("../middleware/session.js", () => ({
  sessionMiddleware: passthroughMiddleware,
  publicSessionMiddleware: passthroughMiddleware,
}));

vi.mock("../services/tasks.js", () => ({
  createTask: vi.fn(),
  listTasks: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  getReadyTasks: vi.fn(),
  updateAcceptanceCriteria: vi.fn(),
  getTask: vi.fn(),
}));

vi.mock("../services/shared/blockers.js", () => ({
  addBlocker: vi.fn(),
  removeBlocker: vi.fn(),
}));

import { tasksRouter } from "./tasks.js";
import {
  createTask,
  listTasks,
  updateTaskStatus,
  updateTask,
  deleteTask,
  getReadyTasks,
  updateAcceptanceCriteria,
  getTask,
} from "../services/tasks.js";
import { addBlocker, removeBlocker } from "../services/shared/blockers.js";
import { NotFoundError, ValidationError } from "../types/errors.js";

const TEST_MEMEX_ID = "00000000-0000-0000-0000-000000000001";
const app = makeTestAppWithTenant({ memexId: TEST_MEMEX_ID });
app.route("/api/tasks", tasksRouter);

const baseDate = new Date("2026-03-25T12:00:00Z");

function makeTask(overrides = {}) {
  return {
    id: "task-uuid-1",
    memexId: "test-account",
    docId: "doc-1",
    seq: 1,
    title: "Build feature",
    description: "Build the feature",
    acceptanceCriteria: [],
    sectionRef: null,
    status: "not_started",
    executionPlanDocId: null,
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    createdAt: baseDate,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("GET /api/tasks/doc/:docId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns list of tasks", async () => {
    vi.mocked(listTasks).mockResolvedValue([makeTask()]);

    const res = await app.request("/api/tasks/doc/doc-1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe("Build feature");
    expect(listTasks).toHaveBeenCalledWith(TEST_MEMEX_ID, "doc-1");
  });
});

describe("GET /api/tasks/doc/:docId/ready", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ready tasks", async () => {
    vi.mocked(getReadyTasks).mockResolvedValue([makeTask()]);

    const res = await app.request("/api/tasks/doc/doc-1/ready");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(getReadyTasks).toHaveBeenCalledWith(TEST_MEMEX_ID, "doc-1");
  });
});

describe("POST /api/tasks/doc/:docId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a task and returns 201", async () => {
    vi.mocked(createTask).mockResolvedValue(testMutate(makeTask()));

    const res = await app.request("/api/tasks/doc/doc-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Build feature", description: "Build the feature" }),
    });

    expect(res.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(TEST_MEMEX_ID, 
      "doc-1", "Build feature", "Build the feature", undefined, undefined
    );
  });

  it("passes acceptance criteria and sectionRef", async () => {
    vi.mocked(createTask).mockResolvedValue(testMutate(makeTask()));

    const criteria = [{ description: "Tests pass", done: false }];
    await app.request("/api/tasks/doc/doc-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Task",
        description: "Desc",
        acceptanceCriteria: criteria,
        sectionRef: "section-2",
      }),
    });

    expect(createTask).toHaveBeenCalledWith(TEST_MEMEX_ID, 
      "doc-1", "Task", "Desc", criteria, "section-2"
    );
  });
});

describe("POST /api/tasks/:id/criteria", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates acceptance criteria", async () => {
    const criteria = [{ description: "Done", done: true }];
    vi.mocked(updateAcceptanceCriteria).mockResolvedValue(testMutate(makeTask({ acceptanceCriteria: criteria })));

    const res = await app.request("/api/tasks/task-uuid-1/criteria", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ criteria }),
    });

    expect(res.status).toBe(200);
    expect(updateAcceptanceCriteria).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1", criteria);
  });
});

describe("POST /api/tasks/:id/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates task status", async () => {
    vi.mocked(updateTaskStatus).mockResolvedValue(testMutate(makeTask({ status: "in_progress" })));

    const res = await app.request("/api/tasks/task-uuid-1/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("in_progress");
    expect(updateTaskStatus).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1", "in_progress");
  });

  it("returns 400 for invalid status", async () => {
    vi.mocked(updateTaskStatus).mockRejectedValue(
      new ValidationError("Invalid status")
    );

    const res = await app.request("/api/tasks/task-uuid-1/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/tasks/:id/blockers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds a blocker and returns updated task", async () => {
    vi.mocked(addBlocker).mockResolvedValue(testMutate(undefined));
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ blocked: true, blockedByDecisions: [{ id: "D-1" }] })
    );

    const res = await app.request("/api/tasks/task-uuid-1/blockers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockedBy: "D-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blocked).toBe(true);
    expect(addBlocker).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1", "D-1");
    expect(getTask).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1");
  });
});

describe("DELETE /api/tasks/:id/blockers/:handle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes a blocker and returns updated task", async () => {
    vi.mocked(removeBlocker).mockResolvedValue(testMutate(undefined));
    vi.mocked(getTask).mockResolvedValue(makeTask());

    const res = await app.request("/api/tasks/task-uuid-1/blockers/D-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(removeBlocker).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1", "D-1");
    expect(getTask).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1");
  });

  it("returns 404 for non-existent task", async () => {
    vi.mocked(removeBlocker).mockRejectedValue(
      new NotFoundError("Task not found")
    );

    const res = await app.request("/api/tasks/bad-id/blockers/D-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/tasks/:id/update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates task title and description", async () => {
    vi.mocked(updateTask).mockResolvedValue(testMutate(makeTask({ title: "New title", description: "New desc" })));

    const res = await app.request("/api/tasks/task-uuid-1/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New title", description: "New desc" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("New title");
    expect(body.description).toBe("New desc");
    expect(updateTask).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1", {
      title: "New title",
      description: "New desc",
    });
  });

  it("updates acceptance criteria", async () => {
    const criteria = [{ description: "Tests pass", done: true }];
    vi.mocked(updateTask).mockResolvedValue(testMutate(makeTask({ acceptanceCriteria: criteria })));

    const res = await app.request("/api/tasks/task-uuid-1/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptanceCriteria: criteria }),
    });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1", {
      acceptanceCriteria: criteria,
    });
  });

  it("clears sectionRef with null", async () => {
    vi.mocked(updateTask).mockResolvedValue(testMutate(makeTask({ sectionRef: null })));

    const res = await app.request("/api/tasks/task-uuid-1/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sectionRef: null }),
    });

    expect(res.status).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1", {
      sectionRef: null,
    });
  });

  it("returns 404 for non-existent task", async () => {
    vi.mocked(updateTask).mockRejectedValue(
      new NotFoundError("Task not found")
    );

    const res = await app.request("/api/tasks/bad-id/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Nope" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/tasks/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a task", async () => {
    vi.mocked(deleteTask).mockResolvedValue(testMutate(makeTask()));

    const res = await app.request("/api/tasks/task-uuid-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("Build feature");
    expect(deleteTask).toHaveBeenCalledWith(TEST_MEMEX_ID, "task-uuid-1");
  });

  it("returns 404 for non-existent task", async () => {
    vi.mocked(deleteTask).mockRejectedValue(
      new NotFoundError("Task not found")
    );

    const res = await app.request("/api/tasks/bad-id", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });
});
