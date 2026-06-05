// spec-115 v0.1.0 server-side route behaviour: hidden flag, metadata bag,
// size-limit validation with key-drop + X-Memex-Warning header.
//
// Built against the Hono route handler directly. The DB layer is mocked so
// the route's `db.insert(...)` calls don't hit a real database; we only
// validate request-shaping and response-shaping.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";

const insertSpy = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([
      { id: "fake-uuid", createdAt: new Date() },
    ]),
  }),
});

vi.mock("../db/connection.js", () => ({
  db: {
    insert: () => insertSpy(),
    // spec-162: the route now writes the log row and the summary upsert inside
    // db.transaction(). Run the callback with a tx that exposes the same insert
    // spy so the payload-shaping assertions below still observe the insert.
    transaction: (cb: (tx: { insert: () => unknown }) => unknown) =>
      cb({ insert: () => insertSpy() }),
  },
}));

// spec-162: the summary maintenance is exercised against a real DB in
// test-event-latest.integration.test.ts; here it's a no-op so this unit test
// stays focused on request/response shaping (and insertSpy stays one-call-per-post).
vi.mock("../services/test-event-latest.js", () => ({
  applyEmissionToSummary: vi.fn().mockResolvedValue(undefined),
}));

// spec-129: the route now requires a valid emission key. These spec-115 unit tests focus
// on payload/metadata shaping, so we stub the auth path to a fixed authorised key whose
// memexId matches the resolver — the auth/memex-match behaviour itself is covered by
// emission-auth.api.test.ts against a real DB.
vi.mock("../services/emission-keys.js", () => ({
  verifyEmissionKey: vi.fn().mockResolvedValue({ id: "key-1", memexId: "memex-1" }),
  resolveMemexId: vi.fn().mockResolvedValue("memex-1"),
  bumpLastUsed: vi.fn(),
}));

import {
  testEventsRouter,
  validateMetadata,
  META_MAX_TOTAL_BYTES,
  META_MAX_KEYS,
  META_MAX_VALUE_CHARS,
} from "./test-events.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-115/acs";

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

let priorOwn: string | undefined;

beforeEach(() => {
  priorOwn = process.env.MEMEX_OWN_NAMESPACE;
  process.env.MEMEX_OWN_NAMESPACE = "mindset-prod";
  insertSpy.mockClear();
});

afterEach(() => {
  if (priorOwn === undefined) {
    delete process.env.MEMEX_OWN_NAMESPACE;
  } else {
    process.env.MEMEX_OWN_NAMESPACE = priorOwn;
  }
});

const validBody = {
  ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
  status: "pass",
  test_identifier: "test.ts::works",
  duration_ms: 42,
};

describe("validateMetadata — server-side caps", () => {
  it("passes through metadata under all caps unchanged (ac-10)", () => {
    tagAc(`${AC}/ac-10`);
    const input = { actor: "wic", branch: "main", tenant: "acme" };
    const result = validateMetadata(input);
    expect(result.metadata).toEqual(input);
    expect(result.dropped).toEqual([]);
  });

  it("drops keys whose values exceed 256 chars (ac-14)", () => {
    tagAc(`${AC}/ac-14`);
    const input = {
      actor: "wic",
      huge: "x".repeat(257),
    };
    const result = validateMetadata(input);
    expect(result.metadata.actor).toBe("wic");
    expect(result.metadata.huge).toBeUndefined();
    expect(result.dropped).toContain("huge");
  });

  it("drops the longest values first when total exceeds 4KB (ac-14)", () => {
    tagAc(`${AC}/ac-14`);
    const input: Record<string, string> = {
      keep_small: "tiny",
      big_a: "a".repeat(200),
      big_b: "b".repeat(200),
      big_c: "c".repeat(200),
    };
    // Each big_* is 200 chars + key overhead ≈ ~220 bytes. With 3 of them
    // plus the small one, total <4KB. Let's add many to push over.
    for (let i = 0; i < 30; i++) {
      input[`filler_${i}`] = "z".repeat(200);
    }
    const result = validateMetadata(input);
    // keep_small should survive (smallest).
    expect(result.metadata.keep_small).toBe("tiny");
    // Total stored size is under the cap.
    expect(JSON.stringify(result.metadata).length).toBeLessThanOrEqual(
      META_MAX_TOTAL_BYTES,
    );
    expect(result.dropped.length).toBeGreaterThan(0);
  });

  it("caps metadata at 32 keys (ac-14)", () => {
    tagAc(`${AC}/ac-14`);
    const input: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      input[`key_${String(i).padStart(2, "0")}`] = "v";
    }
    const result = validateMetadata(input);
    expect(Object.keys(result.metadata).length).toBeLessThanOrEqual(
      META_MAX_KEYS,
    );
    expect(result.dropped.length).toBeGreaterThanOrEqual(40 - META_MAX_KEYS);
  });

  it("drops non-string values entirely", () => {
    const input = {
      good: "value",
      // these are not strings; the server only stores string values
      bad_num: 42 as unknown as string,
      bad_obj: { nested: "x" } as unknown as string,
    };
    const result = validateMetadata(input);
    expect(result.metadata.good).toBe("value");
    expect(result.metadata.bad_num).toBeUndefined();
    expect(result.metadata.bad_obj).toBeUndefined();
    expect(result.dropped).toContain("bad_num");
    expect(result.dropped).toContain("bad_obj");
  });
});

describe("POST /api/test-events — top-level actor (spec-115 dec-6)", () => {
  it("accepts top-level actor as a string [spec-115 dec-6 ac-27]", async () => {
    tagAc(`${AC}/ac-27`);
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({ ...validBody, actor: "wic@mindset.ai" }),
    });
    expect(res.status).toBe(201);
    expect(insertSpy).toHaveBeenCalled();
  });

  it("rejects actor when not a string [spec-115 dec-6 ac-27]", async () => {
    tagAc(`${AC}/ac-27`);
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({ ...validBody, actor: 42 }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a payload with no actor at all (nullable column) [spec-115 dec-6 ac-28]", async () => {
    tagAc(`${AC}/ac-28`);
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
  });

  it("accepts a hand-rolled payload with metadata.actor but does NOT promote it to the top-level column [spec-115 dec-6 ac-29]", async () => {
    tagAc(`${AC}/ac-29`);
    const insertedValues = vi.fn();
    insertSpy.mockReturnValueOnce({
      values: (v: unknown) => {
        insertedValues(v);
        return {
          returning: vi.fn().mockResolvedValue([
            { id: "fake-uuid", createdAt: new Date() },
          ]),
        };
      },
    });

    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({
        ...validBody,
        metadata: { actor: "from-metadata" },
      }),
    });
    expect(res.status).toBe(201);
    // The stored row has actor = null (top-level was not posted) and the
    // metadata bag still contains the opaque "actor" key as a customer
    // metadata. The server made no attempt to promote it.
    const row = insertedValues.mock.calls[0]?.[0];
    expect(row.actor).toBe(null);
    expect(row.metadata).toEqual({ actor: "from-metadata" });
  });
});

describe("POST /api/test-events — hidden + metadata acceptance", () => {
  it("accepts hidden: true in the body", async () => {
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({ ...validBody, hidden: true }),
    });
    expect(res.status).toBe(201);
  });

  it("accepts metadata as an object of string values", async () => {
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({
        ...validBody,
        metadata: { actor: "wic", branch: "main" },
      }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects metadata when not an object", async () => {
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({ ...validBody, metadata: "not-an-object" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects metadata when it's an array", async () => {
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({ ...validBody, metadata: ["a", "b"] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects hidden when not a boolean", async () => {
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({ ...validBody, hidden: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/test-events — overflow behaviour (drop + warn)", () => {
  it("returns 201 (success) even when metadata keys are dropped (ac-13, ac-16)", async () => {
    tagAc(`${AC}/ac-13`);
    tagAc(`${AC}/ac-16`);
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({
        ...validBody,
        metadata: { huge: "x".repeat(500) }, // over 256-char cap
      }),
    });
    expect(res.status).toBe(201);
  });

  it("returns X-Memex-Warning header naming dropped keys (ac-15)", async () => {
    tagAc(`${AC}/ac-15`);
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({
        ...validBody,
        metadata: { actor: "wic", huge: "x".repeat(500) },
      }),
    });
    expect(res.status).toBe(201);
    const warning = res.headers.get("X-Memex-Warning");
    expect(warning).toBeTruthy();
    expect(warning).toContain("huge");
  });

  it("does not emit X-Memex-Warning when no keys were dropped", async () => {
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({
        ...validBody,
        metadata: { actor: "wic", branch: "main" },
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Memex-Warning")).toBeNull();
  });

  it("still inserts the event (with pass/fail) when metadata overflows (ac-13)", async () => {
    tagAc(`${AC}/ac-13`);
    await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({
        ...validBody,
        metadata: { huge: "x".repeat(500) },
      }),
    });
    expect(insertSpy).toHaveBeenCalled();
  });
});

describe("META_MAX_VALUE_CHARS constant is exported", () => {
  it("exports the 256 char value cap", () => {
    expect(META_MAX_VALUE_CHARS).toBe(256);
  });

  it("exports the 32 key cap", () => {
    expect(META_MAX_KEYS).toBe(32);
  });

  it("exports the 4096 byte total cap", () => {
    expect(META_MAX_TOTAL_BYTES).toBe(4096);
  });
});
