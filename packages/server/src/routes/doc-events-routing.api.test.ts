import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

// Force dev-mode auth so app.request() can hit session-gated routes without a JWT.
const ORIGINAL_CLIENT_ID = vi.hoisted(() => {
  const v = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = "";
  return v;
});

import { app } from "../app.js";
import { db } from "../db/connection.js";
import { memexes, users } from "../db/schema.js";
import { bus } from "../services/bus.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";

// t-13: `/api/docs` requires tenant + session.
// t-18 (doc-15 F.3): tenancy-scoped surfaces are now mounted at
// `/api/<namespace>/<memex>/...`. The previous Host: <subdomain>.memex.ai
// shape no longer resolves — hostGuard 404s anything that isn't the apex.
// We seed an org + dev admin + a doc, and exercise the path-prefixed mount.
let testMemexId: string;
let testDocId: string;
let namespaceSlug: string;
const createdMemexIds: string[] = [];
beforeAll(async () => {
  const { memexId, slug } = await makeTestMemexWithDevAdmin("dev");
  createdMemexIds.push(memexId);
  testMemexId = memexId;
  namespaceSlug = slug;
  // Seed a doc owned by the test account so the per-doc /events/:docId stream can verify
  // ownership without 404'ing.
  const doc = await createDocDraft(memexId, "Routing test doc", "Test purpose", "spec");
  testDocId = doc.id;
});

// Path prefix for the seeded memex — makeTestMemexWithDevAdmin pins memex.slug='main'.
function tenantPath(suffix: string): string {
  return `/api/${namespaceSlug}/main${suffix}`;
}
const apexHost = "memex.ai";
afterAll(async () => {
  if (createdMemexIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdMemexIds)).catch(() => {});
    await db.delete(users).where(inArray(users.email, ["dev@memex.ai"])).catch(() => {});
  }
});

/**
 * RED CASE: These tests verify that the SSE event endpoints are reachable
 * through the full app router (not just the isolated docEventsRouter).
 *
 * The bug: The docs router's GET /:id catch-all intercepts /events and
 * /events/:docId before the docEventsRouter can handle them. This causes
 * the SSE endpoints to return 404 (doc "events" not found) instead of
 * streaming SSE events.
 */

/** Read one SSE doc_change event from a response, or timeout */
async function readOneSSEEvent(res: Response, timeoutMs = 2000): Promise<string | null> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), timeoutMs)
  );

  const read = async (): Promise<string | null> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return null;
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
          return data;
        }
      }
    }
  };

  try {
    const result = await Promise.race([read(), timeout]);
    reader.cancel().catch(() => {});
    return result;
  } catch {
    reader.cancel().catch(() => {});
    return null;
  }
}

describe("SSE endpoints through the full app router", () => {
  afterEach(() => {
    // SSE bus subscriptions tear down via stream.onAbort on body cancel
  });

  it("GET /api/<ns>/<mx>/docs/events returns SSE stream (not 404 from /:id catch-all)", async () => {
    const res = await app.request(tenantPath("/docs/events"), { headers: { Host: apexHost } });

    // Should be SSE, not a JSON error from getDoc("events")
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    res.body?.cancel();
  });

  it("GET /api/<ns>/<mx>/docs/events/:docId returns SSE stream (not 404 from /:id catch-all)", async () => {
    const res = await app.request(tenantPath(`/docs/events/${testDocId}`), {
      headers: { Host: apexHost },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    res.body?.cancel();
  });

  it("global events stream receives document creation events", async () => {
    const res = await app.request(tenantPath("/docs/events"), { headers: { Host: apexHost } });
    expect(res.status).toBe(200);

    // Give SSE stream time to register listener
    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: testMemexId,
      docId: "new-doc-id",
      entity: "document",
      action: "created",
    });

    const event = await readOneSSEEvent(res);
    expect(event).not.toBeNull();

    const parsed = JSON.parse(event!);
    expect(parsed).toMatchObject({
      memexId: testMemexId,
      docId: "new-doc-id",
      entity: "document",
      action: "created",
    });
  });

  it("per-doc events stream receives mutations for that document", async () => {
    const res = await app.request(tenantPath(`/docs/events/${testDocId}`), {
      headers: { Host: apexHost },
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    bus.emit({
      memexId: testMemexId,
      docId: testDocId,
      entity: "section",
      action: "updated",
    });

    const event = await readOneSSEEvent(res);
    expect(event).not.toBeNull();

    const parsed = JSON.parse(event!);
    expect(parsed.docId).toBe(testDocId);
  });

  it("per-doc events stream returns 404 when the doc is in another account", async () => {
    // Create a second account; ask for its doc from the first account's path prefix.
    const other = await makeTestMemexWithDevAdmin("dev2");
    createdMemexIds.push(other.memexId);
    const otherDoc = await createDocDraft(other.memexId, "Other-doc", "Other purpose");

    const res = await app.request(tenantPath(`/docs/events/${otherDoc.id}`), {
      headers: { Host: apexHost }, // first tenant prefix — should not see other tenant's doc
    });
    expect(res.status).toBe(404);
  });

  it("existing document routes still work (GET /api/<ns>/<mx>/docs)", async () => {
    const res = await app.request(tenantPath("/docs"), { headers: { Host: apexHost } });
    // Should return the doc list JSON, not be intercepted by events router
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
