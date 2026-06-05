import { describe, it, expect, afterAll, beforeAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

// Force dev-mode auth so app.request() can hit session-gated routes without minting a JWT.
const ORIGINAL_CLIENT_ID = vi.hoisted(() => {
  const v = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "";
  return v;
});

import { db } from "../db/connection.js";
import { documents, docSections, docComments, decisions, tasks } from "../db/schema.js";
import { app } from "../app.js";
import { createDocDraft } from "../services/documents.js";
import { createDecision } from "../services/decisions.js";
import { createTask } from "../services/tasks.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";

/**
 * End-to-end change propagation tests.
 *
 * These verify the FULL pipeline: a mutation via a specific source
 * (REST API, MCP endpoint) triggers a doc change event that reaches
 * a connected SSE client. This is the critical path that was broken
 * when the route ordering was wrong.
 *
 * t-19 of doc-15: rewritten to use path-based routing (Host=memex.ai,
 * URL prefix=`/api/<ns>/<mx>/`).
 */

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(docComments).where(
      eq(docComments.sectionId, id)
    ).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(docSections).where(eq(docSections.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

afterEach(() => {
  // SSE handler subscriptions to the bus are torn down by stream.onAbort when
  // the response body reader is cancelled at the end of each test; no
  // afterEach cleanup needed for the bus (cf. routes/sse-cleanup.integration.test.ts).
});

afterAll(() => {
  if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
});

// SSE response wrapper: holds the response, its (single) reader, and any bytes
// over-read during the `ready` handshake. Subsequent reads share this reader so
// nothing is dropped at lock-release boundaries. (t-19 W5 flake fix.)
interface SSEStream {
  res: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}

/** Open an SSE subscription to the global or per-doc events stream and wait for
 *  the server's `ready` event before returning. Replaces the prior fixed-50ms
 *  sleep — under load that race could miss the listener attachment and the
 *  next mutation would fire into the void. */
async function openSSEStream(docId?: string): Promise<SSEStream> {
  const url = docId
    ? `${memexPath}/docs/events/${docId}`
    : `${memexPath}/docs/events`;
  const res = await app.request(url, withApexHost());
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const stream: SSEStream = { res, reader, buffer: "" };
  await waitForReady(stream);
  return stream;
}

/** Read forward on the shared reader until the `ready` event is consumed. Any
 *  bytes after the ready frame remain in `stream.buffer` so readOneEvent picks
 *  up where this leaves off — no lock release, no dropped data. */
async function waitForReady(stream: SSEStream, timeoutMs = 2000): Promise<void> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (Date.now() > deadline) {
      throw new Error("SSE: timed out waiting for ready event");
    }
    const { done, value } = await stream.reader.read();
    if (done) throw new Error("SSE: stream closed before ready event");
    stream.buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by \n\n. Trim the prelude up through the first
    // `event: ready\n\n` frame; remaining bytes stay in stream.buffer.
    const readyIdx = stream.buffer.search(/(^|\n)event: ?ready\b/);
    if (readyIdx >= 0) {
      const after = stream.buffer.indexOf("\n\n", readyIdx);
      if (after >= 0) {
        stream.buffer = stream.buffer.slice(after + 2);
        return;
      }
      // Found the line but not the frame terminator yet — keep reading.
    }
  }
}

/** Read one doc_change event from an SSE stream, or null on timeout. Uses the
 *  shared reader on the SSEStream so the prelude bytes from waitForReady aren't
 *  dropped, and so multiple sequential reads on the same stream stay in sync. */
async function readOneEvent(stream: SSEStream, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  const decoder = new TextDecoder();

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs)
  );

  const read = async (): Promise<Record<string, unknown> | null> => {
    while (true) {
      // First, try to extract a complete frame from the existing buffer.
      const idx = stream.buffer.indexOf("\n\n");
      if (idx >= 0) {
        const part = stream.buffer.slice(0, idx);
        stream.buffer = stream.buffer.slice(idx + 2);
        if (part.trim()) {
          let eventType = "";
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (eventType === "doc_change" && data) {
            return JSON.parse(data);
          }
        }
        continue; // not a doc_change — try the next frame in buffer.
      }
      // Need more bytes.
      const { done, value } = await stream.reader.read();
      if (done) return null;
      stream.buffer += decoder.decode(value, { stream: true });
    }
  };

  return Promise.race([read(), timeout]);
}

// ─── REST API → SSE ─────────────────────────────────────────


let memexId: string;
let memexPath: string;
beforeAll(async () => {
  const { memexId: id, slug } = await makeTestMemexWithDevAdmin();
  memexId = id;
  memexPath = `/api/${slug}/main`;
});

// All app.request() calls must include Host: memex.ai (the apex) so hostGuard
// accepts them; path-based routing carries the namespace + memex.
function withApexHost(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers ?? {}), Host: "memex.ai" },
  };
}

describe("REST API mutations propagate to SSE clients (t-19 path-routing)", () => {
  let docId: string;
  let sectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "REST Propagation Test", "Purpose");
    docId = doc.id;
    sectionId = doc.sections[0].id;
    createdDocIds.push(doc.id);
  });

  it("POST /api/<ns>/<mx>/decisions/doc/:docId → SSE event on per-doc stream", async () => {
    const sseRes = await openSSEStream(docId);

    // Make a REST API call to create a decision
    const mutationRes = await app.request(`${memexPath}/decisions/doc/${docId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ title: "REST decision test" }),
    });
    expect(mutationRes.status).toBe(201);

    // Verify the SSE stream received the event
    const event = await readOneEvent(sseRes);
    expect(event).not.toBeNull();
    expect(event!.docId).toBe(docId);
    expect(event!.entity).toBe("decision");
    expect(event!.action).toBe("created");
  });

  it("POST /api/<ns>/<mx>/comments/section/:sectionId → SSE event on per-doc stream", async () => {
    const sseRes = await openSSEStream(docId);

    const mutationRes = await app.request(`${memexPath}/comments/section/${sectionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ authorName: "Tester", content: "REST comment" }),
    });
    expect(mutationRes.status).toBe(201);

    const event = await readOneEvent(sseRes);
    expect(event).not.toBeNull();
    expect(event!.docId).toBe(docId);
    expect(event!.entity).toBe("comment");
    expect(event!.action).toBe("created");
  });

  it("POST /api/<ns>/<mx>/tasks/doc/:docId → SSE event on per-doc stream", async () => {
    const sseRes = await openSSEStream(docId);

    const mutationRes = await app.request(`${memexPath}/tasks/doc/${docId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ title: "REST task", description: "Test" }),
    });
    expect(mutationRes.status).toBe(201);

    const event = await readOneEvent(sseRes);
    expect(event).not.toBeNull();
    expect(event!.docId).toBe(docId);
    expect(event!.entity).toBe("task");
    expect(event!.action).toBe("created");
  });

  it("REST mutation on doc A does NOT appear on doc B stream", async () => {
    const docB = await createDocDraft(memexId, "Doc B", "Purpose");
    createdDocIds.push(docB.id);

    // Subscribe to doc B
    const sseRes = await openSSEStream(docB.id);

    // Mutate doc A
    await app.request(`${memexPath}/decisions/doc/${docId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ title: "Wrong doc" }),
    });

    // Should NOT receive the event (timeout expected)
    const event = await readOneEvent(sseRes, 500);
    expect(event).toBeNull();
  });
});

// ─── REST API → Global SSE ─────────────────────────────────

describe("REST API mutations propagate to global SSE stream (DocList) (t-19 path-routing)", () => {
  it("creating a decision on any doc triggers global stream", async () => {
    const doc = await createDocDraft(memexId, "Global Stream Test", "Purpose");
    createdDocIds.push(doc.id);

    const sseRes = await openSSEStream(); // global, no docId

    await app.request(`${memexPath}/decisions/doc/${doc.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ title: "Global test" }),
    });

    const event = await readOneEvent(sseRes);
    expect(event).not.toBeNull();
    expect(event!.docId).toBe(doc.id);
    expect(event!.entity).toBe("decision");
  });
});

// ─── MCP → SSE ─────────────────────────────────────────────

/**
 * MCP tool calls use the same service functions as REST API routes.
 * The REST tests above prove: service mutation → emitDocChange → SSE event.
 * The existing mcp/tools.test.ts proves: MCP tool → service function.
 * Therefore: MCP tool → service → event → SSE works transitively.
 *
 * We test the MCP → service → event path directly (bypassing the MCP
 * transport protocol) to prove the event emission without the complexity
 * of MCP Streamable HTTP session negotiation.
 */
describe("MCP tool calls propagate to SSE clients (t-19 path-routing)", () => {
  it("MCP update_section service call → SSE event on per-doc stream", async () => {
    const { updateSection } = await import("../services/sections.js");

    const doc = await createDocDraft(memexId, "MCP Propagation Test", "Purpose");
    createdDocIds.push(doc.id);
    const sectionId = doc.sections[0].id;

    const sseRes = await openSSEStream(doc.id);

    // Simulate MCP calling the service function (same code path as MCP tools)
    await updateSection(memexId, sectionId, "Updated via MCP");

    const event = await readOneEvent(sseRes);
    expect(event).not.toBeNull();
    expect(event!.docId).toBe(doc.id);
    expect(event!.entity).toBe("section");
    expect(event!.action).toBe("updated");
  });

  it("MCP create_task service call → SSE event on global stream", async () => {
    const doc = await createDocDraft(memexId, "MCP Global Test", "Purpose");
    createdDocIds.push(doc.id);

    const sseRes = await openSSEStream(); // global

    // Simulate MCP calling the service function
    await createTask(memexId, doc.id, "MCP task", "Created from MCP");

    const event = await readOneEvent(sseRes);
    expect(event).not.toBeNull();
    expect(event!.docId).toBe(doc.id);
    expect(event!.entity).toBe("task");
    expect(event!.action).toBe("created");
  });
});

// ─── Multiple concurrent clients ────────────────────────────

describe("Multiple SSE clients on same document (t-19 path-routing)", () => {
  it("both clients receive the same event", async () => {
    const doc = await createDocDraft(memexId, "Multi Client Test", "Purpose");
    createdDocIds.push(doc.id);

    const client1 = await openSSEStream(doc.id);
    const client2 = await openSSEStream(doc.id);

    await app.request(`${memexPath}/decisions/doc/${doc.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "memex.ai" },
      body: JSON.stringify({ title: "Multi-client test" }),
    });

    const [event1, event2] = await Promise.all([
      readOneEvent(client1),
      readOneEvent(client2),
    ]);

    expect(event1).not.toBeNull();
    expect(event2).not.toBeNull();
    expect(event1!.docId).toBe(doc.id);
    expect(event2!.docId).toBe(doc.id);
  });
});
