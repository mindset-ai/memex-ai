// Verifies that the SSE handlers (rewired in t-3 to subscribe directly to the
// bus) tear down their bus subscriptions when a connection is aborted. Without
// this contract the bus accumulates orphan listeners over the lifetime of the
// process — every disconnected client would leave a dead handler in the Set,
// driving emit cost up linearly in disconnect count.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("../middleware/session.js", async () => {
  const { createMiddleware } = await import("hono/factory");
  return {
    sessionMiddleware: createMiddleware(async (_c: unknown, next: () => Promise<void>) =>
      next(),
    ),
  };
});

import { docEventsRouter } from "./doc-events.js";
import { bus } from "../services/bus.js";
import { makeTestAppWithTenant } from "./route-test-helpers.js";
import { db } from "../db/connection.js";

const TEST_MEMEX_ID = "00000000-0000-0000-0000-000000000001";
const TEST_DOC_ID = "11111111-1111-1111-1111-111111111111";

function makeApp(memexId: string = TEST_MEMEX_ID) {
  const app = makeTestAppWithTenant({ memexId });
  app.route("/api/docs", docEventsRouter);
  return app;
}

function stubDocLookup() {
  return vi.spyOn(db.query.documents, "findFirst").mockResolvedValue({
    id: TEST_DOC_ID,
    memexId: TEST_MEMEX_ID,
    handle: "doc-1",
    title: "Test",
    docType: "spec",
    status: "draft",
  } as unknown as never);
}

describe("SSE handler tears down bus subscriptions on abort", () => {
  beforeEach(() => {
    // Baseline expectation: before any handler runs there are no live
    // subscribers from this test fixture. We don't call bus._reset() because
    // doing so would clear subscribers in unrelated tests running in the same
    // process — we simply assert that disconnect drives the count back down.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("per-doc stream: N connections opened then aborted return the bus to its baseline subscriber count", async () => {
    stubDocLookup();
    const baseline = bus._listenerCount();
    const app = makeApp();

    const N = 5;
    const responses: Response[] = [];
    for (let i = 0; i < N; i++) {
      responses.push(await app.request(`/api/docs/events/${TEST_DOC_ID}`));
    }

    // Give the streamSSE handler a tick to register its bus.subscribe call.
    // Each connection opens 2 subscriptions: one for doc changes, one for the
    // org_membership revoke signal added in spec-199 t-4.
    await new Promise((r) => setTimeout(r, 50));
    expect(bus._listenerCount()).toBe(baseline + N * 2);

    // Cancel each response body — this triggers stream.onAbort which calls the
    // unsubscribe returned by bus.subscribe.
    for (const res of responses) {
      await res.body!.cancel();
    }

    // onAbort dispatch is async; give the runtime a tick to drain.
    await new Promise((r) => setTimeout(r, 100));
    expect(bus._listenerCount()).toBe(baseline);
  });

  it("per-Memex stream: N connections opened then aborted return the bus to its baseline subscriber count", async () => {
    const baseline = bus._listenerCount();
    const app = makeApp();

    const N = 5;
    const responses: Response[] = [];
    for (let i = 0; i < N; i++) {
      responses.push(await app.request("/api/docs/events"));
    }

    // Each connection opens 2 subscriptions (memex stream + org_membership revoke).
    await new Promise((r) => setTimeout(r, 50));
    expect(bus._listenerCount()).toBe(baseline + N * 2);

    for (const res of responses) {
      await res.body!.cancel();
    }

    await new Promise((r) => setTimeout(r, 100));
    expect(bus._listenerCount()).toBe(baseline);
  });
});
