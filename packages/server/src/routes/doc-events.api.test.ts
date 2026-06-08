import { describe, it, expect, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

// vi.mock() is hoisted above all imports — the factory must be self-contained, so we
// re-create a passthrough middleware inline rather than importing one. This is the same
// shape as `route-test-helpers.ts`'s `passthroughMiddleware` (it just calls next()).
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
const OTHER_ACCOUNT_ID = "00000000-0000-0000-0000-000000000099";
const TEST_DOC_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_DOC_ID = "22222222-2222-2222-2222-222222222222";
// Matches the default userId injected by makeTestAppWithTenant / tenantStubMiddleware.
const TEST_USER_ID = "00000000-0000-0000-0000-000000000010";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000020";

function makeApp(memexId: string = TEST_MEMEX_ID) {
  const app = makeTestAppWithTenant({ memexId });
  app.route("/api/docs", docEventsRouter);
  return app;
}

/**
 * Stub the per-doc ownership check. The real router calls
 * db.query.documents.findFirst with a where clause that matches docId AND memexId;
 * drizzle's SQL fragment objects aren't introspectable from the outside, so each
 * test asserts the *response* (200 / 404) by toggling the stub's return value.
 *
 * Pass `null` to simulate "no matching doc" (cross-account or unknown id) — the
 * handler should 404. Pass `'owned'` to simulate "doc found in this account" — the
 * handler should open the SSE stream.
 */
function stubDocLookup(result: "owned" | null) {
  const row =
    result === "owned"
      ? {
          id: TEST_DOC_ID,
          memexId: TEST_MEMEX_ID,
          handle: "doc-1",
          title: "Test",
          docType: "spec",
          status: "draft",
        }
      : undefined;
  return vi
    .spyOn(db.query.documents, "findFirst")
    .mockResolvedValue(row as unknown as never);
}

/** Read SSE events from a response until we have `count` doc_change events or timeout */
async function readSSEEvents(
  res: Response,
  count: number,
  timeoutMs = 2000,
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
        if (eventType === "doc_change" && data) {
          events.push(data);
        }
      }
    }
  };

  try {
    await Promise.race([read(), timeout]);
  } catch {
    // Timeout is fine — return what we have
  }

  reader.cancel().catch(() => {});
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

describe("GET /api/docs/events/:docId", () => {
  afterEach(() => {
    // No-op: SSE bus subscriptions are torn down by stream.onAbort on body cancel
    vi.restoreAllMocks();
  });

  it("returns SSE content-type", async () => {
    stubDocLookup("owned");
    const app = makeApp();
    const res = await app.request(`/api/docs/events/${TEST_DOC_ID}`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    res.body?.cancel();
  });

  it("404s when the doc belongs to another account", async () => {
    stubDocLookup(null);
    const app = makeApp(TEST_MEMEX_ID);
    const res = await app.request(`/api/docs/events/${OTHER_DOC_ID}`);
    expect(res.status).toBe(404);
  });

  it("receives events for the subscribed document", async () => {
    stubDocLookup("owned");
    const app = makeApp();
    const res = await app.request(`/api/docs/events/${TEST_DOC_ID}`);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "section",
      action: "updated",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);

    const parsed = JSON.parse(events[0]);
    expect(parsed).toMatchObject({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "section",
      action: "updated",
    });
  });

  it("filters out events for other documents", async () => {
    stubDocLookup("owned");
    const app = makeApp();
    const res = await app.request(`/api/docs/events/${TEST_DOC_ID}`);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "33333333-3333-3333-3333-333333333333",
      entity: "section",
      action: "updated",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "decision",
      action: "created",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "33333333-3333-3333-3333-333333333333",
      entity: "task",
      action: "created",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.docId).toBe(TEST_DOC_ID);
    expect(parsed.entity).toBe("decision");
  });

  it("filters out events from other memexes on the same docId", async () => {
    // Defence-in-depth: even if a docId collision were possible across tenants, the
    // listener also checks memexId. UUIDs make this astronomically unlikely; the
    // test asserts the contract anyway.
    stubDocLookup("owned");
    const app = makeApp(TEST_MEMEX_ID);
    const res = await app.request(`/api/docs/events/${TEST_DOC_ID}`);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: OTHER_ACCOUNT_ID,
      docId: TEST_DOC_ID,
      entity: "section",
      action: "updated",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "decision",
      action: "created",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.entity).toBe("decision");
    expect(parsed.memexId).toBe(TEST_MEMEX_ID);
  });

  it("delivers multiple events in sequence", async () => {
    stubDocLookup("owned");
    const app = makeApp();
    const res = await app.request(`/api/docs/events/${TEST_DOC_ID}`);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "section",
      action: "created",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "comment",
      action: "created",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "task",
      action: "updated",
    });

    const events = await readSSEEvents(res, 3);
    expect(events).toHaveLength(3);

    const entities = events.map((e) => JSON.parse(e).entity);
    expect(entities).toEqual(["section", "comment", "task"]);
  });
});

describe("GET /api/docs/events (global)", () => {
  afterEach(() => {
    // No-op: SSE bus subscriptions are torn down by stream.onAbort on body cancel
    vi.restoreAllMocks();
  });

  it("receives events for documents in the current account", async () => {
    const app = makeApp(TEST_MEMEX_ID);
    const res = await app.request("/api/docs/events");

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "doc-a",
      entity: "document",
      action: "created",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "doc-b",
      entity: "section",
      action: "updated",
    });

    const events = await readSSEEvents(res, 2);
    expect(events).toHaveLength(2);

    const docIds = events.map((e) => JSON.parse(e).docId);
    expect(docIds).toEqual(["doc-a", "doc-b"]);
  });

  it("does not leak events from other memexes", async () => {
    const app = makeApp(TEST_MEMEX_ID);
    const res = await app.request("/api/docs/events");

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: OTHER_ACCOUNT_ID,
      docId: "leaked-doc",
      entity: "document",
      action: "created",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "mine",
      entity: "section",
      action: "updated",
    });
    bus.emit({
      memexId: OTHER_ACCOUNT_ID,
      docId: "leaked-2",
      entity: "task",
      action: "created",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.docId).toBe("mine");
    expect(parsed.memexId).toBe(TEST_MEMEX_ID);
  });
});

// Pulse (b-60) t-11 / dec-5. The `?include=` param maps to a ChangeFilter
// action allowlist resolved ONCE per connection:
//   absent | "mutations" → created/updated/deleted only (preserves the historical
//                           contract for every existing consumer).
//   "all"                → every action delivered, including reads (viewed, etc.).
//   unknown              → treated as "mutations" (safe default).
// Each test emits a mutation (created) AND a read (viewed) and asserts which the
// stream delivers. Because the SSE stream cannot signal "I will NOT deliver this
// event", we order the emits read-then-mutation and assert the read is absent by
// confirming the FIRST delivered event is the mutation, not the read.
describe("GET /api/docs/events (?include= action filter)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("include=mutations delivers mutations and filters out reads", async () => {
    const app = makeApp(TEST_MEMEX_ID);
    const res = await app.request("/api/docs/events?include=mutations");

    await new Promise((r) => setTimeout(r, 50));

    // Emit the read FIRST: under the mutations allowlist it must be dropped, so
    // the first (and only) delivered event is the subsequent mutation.
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "read-doc",
      entity: "document",
      action: "viewed",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "mut-doc",
      entity: "section",
      action: "updated",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.action).toBe("updated");
    expect(parsed.docId).toBe("mut-doc");
  });

  it("absent include param defaults to mutations (reads filtered out)", async () => {
    const app = makeApp(TEST_MEMEX_ID);
    const res = await app.request("/api/docs/events");

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "read-doc",
      entity: "document",
      action: "viewed",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "mut-doc",
      entity: "section",
      action: "updated",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.action).toBe("updated");
    expect(parsed.docId).toBe("mut-doc");
  });

  it("include=all delivers both reads and mutations", async () => {
    const app = makeApp(TEST_MEMEX_ID);
    const res = await app.request("/api/docs/events?include=all");

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "read-doc",
      entity: "document",
      action: "viewed",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "mut-doc",
      entity: "section",
      action: "updated",
    });

    const events = await readSSEEvents(res, 2);
    expect(events).toHaveLength(2);
    const actions = events.map((e) => JSON.parse(e).action);
    expect(actions).toEqual(["viewed", "updated"]);
  });

  it("unknown include value falls back to mutations (reads filtered out)", async () => {
    const app = makeApp(TEST_MEMEX_ID);
    const res = await app.request("/api/docs/events?include=bogus");

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "read-doc",
      entity: "document",
      action: "viewed",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: "mut-doc",
      entity: "task",
      action: "created",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]);
    expect(parsed.action).toBe("created");
    expect(parsed.docId).toBe("mut-doc");
  });
});

// Per-doc stream (`/events/:docId`) shares the same `?include=` resolution.
describe("GET /api/docs/events/:docId (?include= action filter)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("include=all delivers a viewed event on the per-doc stream", async () => {
    stubDocLookup("owned");
    const app = makeApp();
    const res = await app.request(`/api/docs/events/${TEST_DOC_ID}?include=all`);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "document",
      action: "viewed",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]).action).toBe("viewed");
  });

  it("include=mutations filters out a viewed event on the per-doc stream", async () => {
    stubDocLookup("owned");
    const app = makeApp();
    const res = await app.request(
      `/api/docs/events/${TEST_DOC_ID}?include=mutations`,
    );

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "document",
      action: "viewed",
    });
    bus.emit({
      memexId: TEST_MEMEX_ID,
      docId: TEST_DOC_ID,
      entity: "section",
      action: "updated",
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]).action).toBe("updated");
  });
});

const AC_199 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-199/acs/ac-${n}`;

// spec-199 t-4 — in-flight SSE streams are torn down when org membership is revoked.
describe("spec-199 t-4 — SSE streams close on org_membership revocation (ac-4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("per-doc stream closes when org_membership deleted fires for the connected user", async () => {
    tagAc(AC_199(4));
    stubDocLookup("owned");
    const app = makeApp();
    const res = await app.request(`/api/docs/events/${TEST_DOC_ID}`);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      userId: TEST_USER_ID,
      entity: "org_membership",
      action: "deleted",
    });

    await waitForStreamClose(res);
    // If waitForStreamClose resolves without throwing, the stream closed cleanly.
  });

  it("global stream closes when org_membership deleted fires for the connected user", async () => {
    tagAc(AC_199(4));
    const app = makeApp();
    const res = await app.request("/api/docs/events");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      userId: TEST_USER_ID,
      entity: "org_membership",
      action: "deleted",
    });

    await waitForStreamClose(res);
  });

  it("per-doc stream does not close when a DIFFERENT user's membership is revoked", async () => {
    tagAc(AC_199(4));
    stubDocLookup("owned");
    const app = makeApp();
    const res = await app.request(`/api/docs/events/${TEST_DOC_ID}`);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      userId: OTHER_USER_ID,
      entity: "org_membership",
      action: "deleted",
    });

    // Stream must stay open — waitForStreamClose should timeout.
    // (waitForStreamClose's finally block handles reader cleanup.)
    await expect(waitForStreamClose(res, 300)).rejects.toThrow("did not close");
  });

  it("global stream does not close when a DIFFERENT user's membership is revoked", async () => {
    tagAc(AC_199(4));
    const app = makeApp();
    const res = await app.request("/api/docs/events");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: TEST_MEMEX_ID,
      userId: OTHER_USER_ID,
      entity: "org_membership",
      action: "deleted",
    });

    await expect(waitForStreamClose(res, 300)).rejects.toThrow("did not close");
  });
});
