// Per-user SSE channel — /api/me/events (doc-16 phase-2 follow-up).
//
// Covers the user-scoped fan-out: bus events that carry a `userId` reach the
// session's user, Memex-scoped events without `userId` (or with a different
// userId) are filtered out.

import { describe, it, expect, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

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

/** Reads all user_change events until the stream closes or the timeout fires. */
async function drainSSEUntilClose(res: Response, timeoutMs = 2000): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let buffer = "";
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("stream did not close within timeout")), timeoutMs),
  );
  const drain = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        let eventType = "", data = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (eventType === "user_change" && data) events.push(data);
      }
    }
  };
  try {
    await Promise.race([drain(), timeout]);
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

/** Reads the stream until it closes (done:true) or the timeout fires. */
async function waitForStreamClose(res: Response, timeoutMs = 2000): Promise<void> {
  const reader = res.body!.getReader();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("stream did not close within timeout")), timeoutMs),
  );
  const waitClose = async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  };
  try {
    await Promise.race([waitClose(), timeout]);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const AC_199 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-199/acs/ac-${n}`;

// spec-199 t-4 — /api/me/events stream closes when the user's org membership is revoked.
describe("spec-199 t-4 — me/events stream closes on org_membership revocation (ac-4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stream closes when org_membership deleted fires for the connected user", async () => {
    tagAc(AC_199(4));
    const app = makeApp();
    const res = await app.request("/api/me/events");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: "",
      userId: TEST_USER_ID,
      entity: "org_membership",
      action: "deleted",
    });

    await waitForStreamClose(res);
  });

  it("stream closes in include=all mode when org_membership deleted fires", async () => {
    tagAc(AC_199(4));
    const app = makeApp();
    const res = await app.request("/api/me/events?include=all");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: "",
      userId: TEST_USER_ID,
      entity: "org_membership",
      action: "deleted",
    });

    await waitForStreamClose(res);
  });

  it("stream does not close when a DIFFERENT user's membership is revoked", async () => {
    tagAc(AC_199(4));
    const app = makeApp();
    const res = await app.request("/api/me/events");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: "",
      userId: OTHER_USER_ID,
      entity: "org_membership",
      action: "deleted",
    });

    // Stream must stay open — waitForStreamClose should timeout.
    // (waitForStreamClose's finally block handles reader cleanup.)
    await expect(waitForStreamClose(res, 300)).rejects.toThrow("did not close");
  });

  it("org_membership deleted event is NOT forwarded to the client (silent close)", async () => {
    tagAc(AC_199(4));
    const app = makeApp();
    const res = await app.request("/api/me/events");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    // Emit the revocation; the stream should close without forwarding any user_change event.
    bus.emit({ memexId: "", userId: TEST_USER_ID, entity: "org_membership", action: "deleted" });

    const events = await drainSSEUntilClose(res);
    expect(events).toHaveLength(0);
  });
});
