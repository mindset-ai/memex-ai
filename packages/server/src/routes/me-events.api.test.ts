// Per-user SSE channel — /api/me/events (doc-16 phase-2 follow-up).
//
// Covers the user-scoped fan-out: bus events that carry a `userId` reach the
// session's user, Memex-scoped events without `userId` (or with a different
// userId) are filtered out.

import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../middleware/session.js", async () => {
  const { createMiddleware } = await import("hono/factory");
  return {
    sessionMiddleware: createMiddleware(async (_c: unknown, next: () => Promise<void>) =>
      next(),
    ),
  };
});

import { meRouter } from "./me.js";
import { bus } from "../services/bus.js";
import { makeTestAppWithTenant } from "./route-test-helpers.js";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000010";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000020";
const TEST_MEMEX_ID = "00000000-0000-0000-0000-000000000001";

function makeApp(userId = TEST_USER_ID) {
  const app = makeTestAppWithTenant({ userId });
  app.route("/api/me", meRouter);
  return app;
}

async function readUserChangeEvents(
  res: Response,
  count: number,
  timeoutMs = 1500,
): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let buffer = "";

  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("SSE read timeout")), timeoutMs),
  );

  const read = async () => {
    while (events.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        let eventType = "";
        let data = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (eventType === "user_change" && data) events.push(data);
      }
    }
  };

  try {
    await Promise.race([read(), timeout]);
  } catch {
    // Timeout is fine — return what we have.
  }
  reader.cancel().catch(() => {});
  return events;
}

describe("GET /api/me/events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns SSE content-type", async () => {
    const app = makeApp();
    const res = await app.request("/api/me/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    res.body?.cancel();
  });

  it("receives events tagged with this user's id", async () => {
    const app = makeApp();
    const res = await app.request("/api/me/events");
    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: "",
      userId: TEST_USER_ID,
      entity: "mcp_token",
      action: "created",
    });

    const events = await readUserChangeEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed).toMatchObject({
      userId: TEST_USER_ID,
      entity: "mcp_token",
      action: "created",
    });
  });

  it("filters out events for a different user", async () => {
    const app = makeApp();
    const res = await app.request("/api/me/events");
    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: "",
      userId: OTHER_USER_ID,
      entity: "mcp_token",
      action: "created",
    });
    bus.emit({
      memexId: "",
      userId: TEST_USER_ID,
      entity: "mcp_token",
      action: "deleted",
    });

    const events = await readUserChangeEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.userId).toBe(TEST_USER_ID);
    expect(parsed.action).toBe("deleted");
  });

  it("filters out Memex-scoped events that have no userId", async () => {
    // The per-user channel must not leak Memex-scoped doc/section/task events
    // — those flow on /api/<ns>/<mx>/docs/events. The bus filter compares
    // userId by strict equality; an undefined event.userId never matches a
    // string filter.userId.
    const app = makeApp();
    const res = await app.request("/api/me/events");
    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "00000000-0000-0000-0000-000000000100",
      entity: "section",
      action: "updated",
    });
    bus.emit({
      memexId: "",
      userId: TEST_USER_ID,
      entity: "mcp_token",
      action: "created",
    });

    const events = await readUserChangeEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.entity).toBe("mcp_token");
  });
});
