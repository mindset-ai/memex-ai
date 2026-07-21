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

// spec-398: the route also trims-on-write and snapshots first-verified inside the
// transaction (both call tx.execute). The mocked tx above only stubs .insert, so
// stub these to no-ops — the real behaviour is covered against a real DB in
// spec-398-retention.integration.test.ts.
vi.mock("../services/test-event-retention.js", () => ({
  trimTestEventsForPair: vi.fn().mockResolvedValue(undefined),
  recordFirstVerified: vi.fn().mockResolvedValue(undefined),
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
  MAX_BATCH_EVENTS,
} from "./test-events.js";
// spec-333: the mocked emission-keys module (see vi.mock above) — imported so individual
// tests can override verifyEmissionKey to exercise the scoped-key / missing-key 401 paths.
// spec-489: resolveMemexId is imported too so a batch test can force ONE event to resolve to a
// different Memex than the key authorises (the in-batch auth-boundary case).
import { verifyEmissionKey, resolveMemexId } from "../services/emission-keys.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-115/acs";
const AC333 = "mindset-prod/memex-building-itself/specs/spec-333/acs";

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

beforeEach(() => {
  insertSpy.mockClear();
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

describe("POST /api/test-events — metadata acceptance", () => {
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
});

// spec-358 — the inbound `hidden` field is accepted for backward compatibility
// but no longer honoured: any value returns 201, the row is stored as a
// counting result (hidden=false), and the summary maintenance is NOT skipped,
// so a new result always counts. No X-Memex-Warning is emitted on its account.
const AC_358 = "mindset-prod/memex-building-itself/specs/spec-358/acs";

describe("POST /api/test-events — inbound hidden is accepted but ignored (spec-358)", () => {
  // Capture the values written to the log row so we can assert hidden is forced
  // to false regardless of what the emitter sent.
  function captureInsert() {
    const insertedValues = vi.fn();
    insertSpy.mockReturnValue({
      values: (v: unknown) => {
        insertedValues(v);
        return {
          returning: vi
            .fn()
            .mockResolvedValue([{ id: "fake-uuid", createdAt: new Date() }]),
        };
      },
    });
    return insertedValues;
  }

  it("accepts hidden:true and stores a counting row (hidden=false) [ac-1][ac-2][ac-11]", async () => {
    tagAc(`${AC_358}/ac-1`);
    tagAc(`${AC_358}/ac-2`);
    tagAc(`${AC_358}/ac-11`);
    const insertedValues = captureInsert();
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({ ...validBody, status: "fail", hidden: true }),
    });
    expect(res.status).toBe(201);
    // No suppression: the stored row counts, and no warning header fired for hidden.
    expect(res.headers.get("X-Memex-Warning")).toBeNull();
    const row = insertedValues.mock.calls[0]?.[0];
    expect(row.hidden).toBe(false);
    expect(row.status).toBe("fail");
  });

  it("accepts a non-boolean hidden value without a 400 (was previously rejected) [ac-1][ac-11]", async () => {
    tagAc(`${AC_358}/ac-1`);
    tagAc(`${AC_358}/ac-11`);
    const insertedValues = captureInsert();
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify({ ...validBody, hidden: "yes" }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Memex-Warning")).toBeNull();
    const row = insertedValues.mock.calls[0]?.[0];
    expect(row.hidden).toBe(false);
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

describe("POST /api/test-events — spec-333: agent-actionable 401 bodies", () => {
  it("missing/invalid/expired-key 401 tells a coding agent to call provision_ac_emission, still routing CI to a key (ac-6)", async () => {
    tagAc(`${AC333}/ac-6`);
    tagAc(`${AC333}/ac-1`); // scope outcome: an expired-key agent sees the re-provision instruction
    // No Authorization header → rawKey is "" → emissionKey resolves null without even calling
    // verifyEmissionKey: this is the SAME branch a missing, invalid, OR expired key lands in.
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { message: string };
    expect(json.message).toContain("provision_ac_emission");
    expect(json.message).toMatch(/expired/i); // covers the expired case without an oracle
    expect(json.message).toContain("MEMEX_EMIT_KEY"); // CI path still named
  });

  it("wrong-spec scoped-key 401 names BOTH Specs and gives the provision_ac_emission call for the target (ac-7)", async () => {
    tagAc(`${AC333}/ac-7`);
    tagAc(`${AC333}/ac-2`); // scope outcome: wrong-spec failure names both Specs + the fix
    // A scoped (agent) key for spec-999 emitting against an ac_uid under spec-1.
    vi.mocked(verifyEmissionKey).mockResolvedValueOnce({
      id: "key-1",
      memexId: "memex-1",
      scopedSpecHandle: "spec-999",
    } as never);
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_scoped" },
      body: JSON.stringify(validBody), // ac_uid → mindset-prod/foo/specs/spec-1/acs/ac-1
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { message: string };
    expect(json.message).toContain("spec-999"); // the key's scoped Spec
    expect(json.message).toContain("spec-1"); // the target Spec
    expect(json.message).toContain("provision_ac_emission");
    expect(json.message).toContain("mindset-prod/foo/specs/spec-1"); // the exact target ref
  });
});

describe("POST /api/test-events — spec-333: messaging change preserves accept/reject (ac-10)", () => {
  it("an in-scope scoped key still emits (201) and an out-of-scope scoped key is still rejected (401)", async () => {
    tagAc(`${AC333}/ac-10`);
    tagAc(`${AC333}/ac-5`); // scope outcome: security posture (accept/reject) unchanged
    tagAc(`${AC333}/ac-11`); // deferral held: no scope-widening behaviour shipped
    // In-scope: the key's scope matches the ac_uid's Spec → accept (unchanged behaviour).
    vi.mocked(verifyEmissionKey).mockResolvedValueOnce({
      id: "key-1",
      memexId: "memex-1",
      scopedSpecHandle: "spec-1",
    } as never);
    const ok = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_inscope" },
      body: JSON.stringify(validBody),
    });
    expect(ok.status).toBe(201);

    // Out-of-scope: different Spec → reject (unchanged behaviour; only the message text moved).
    vi.mocked(verifyEmissionKey).mockResolvedValueOnce({
      id: "key-1",
      memexId: "memex-1",
      scopedSpecHandle: "spec-2",
    } as never);
    const denied = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_outscope" },
      body: JSON.stringify(validBody),
    });
    expect(denied.status).toBe(401);
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

// spec-489 G1 — POST /api/test-events/batch. The durable relief for the CI-burst
// problem: many emissions ride ONE authenticated request instead of one POST per
// tagged test (ac-3), with semantics identical to N single POSTs (ac-5). Same
// mocked DB / auth harness as the single-event tests above.
const AC489 = "mindset-prod/memex-building-itself/specs/spec-489/acs";

describe("POST /api/test-events/batch — spec-489 G1 (batch the burst)", () => {
  // Widened past validBody's four keys so a test can add actor / metadata / an
  // invalid status when exercising a specific in-batch code path.
  const ev = (over: Record<string, unknown> = {}) => ({ ...validBody, ...over });

  const postBatch = (events: unknown, auth = true) =>
    app.request("/api/test-events/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer mxk_test" } : {}),
      },
      body: JSON.stringify({ events }),
    });

  it("ingests N events in ONE request → N inserts, accepted=N (ac-3, ac-5)", async () => {
    tagAc(`${AC489}/ac-3`);
    tagAc(`${AC489}/ac-5`);
    const res = await postBatch([
      ev({ test_identifier: "a" }),
      ev({ test_identifier: "b" }),
      ev({ test_identifier: "c" }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      accepted: number;
      rejected: number;
      results: Array<{ ok: boolean }>;
    };
    expect(json.accepted).toBe(3);
    expect(json.rejected).toBe(0);
    expect(json.results).toHaveLength(3);
    expect(json.results.every((r) => r.ok)).toBe(true);
    // One request, but one insert PER event — same DB path as a single POST, just
    // no longer one HTTP round trip (and one pool slot) per tagged test.
    expect(insertSpy).toHaveBeenCalledTimes(3);
  });

  it("authenticates ONCE per batch — a missing key 401s the whole batch, zero inserts (ac-5)", async () => {
    tagAc(`${AC489}/ac-5`);
    const res = await postBatch([ev(), ev()], /* auth */ false);
    expect(res.status).toBe(401);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("partial failure — a malformed event is rejected but its neighbours still land (ac-5)", async () => {
    tagAc(`${AC489}/ac-5`);
    const res = await postBatch([
      ev({ test_identifier: "good1" }),
      ev({ status: "bogus" }), // invalid status → rejected in-batch
      ev({ test_identifier: "good2" }),
    ]);
    // The batch as a whole succeeds (200) even though one event failed — a bad
    // event does NOT 400 the request or discard the good events.
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      accepted: number;
      rejected: number;
      results: Array<{ index: number; ok: boolean; error?: string }>;
    };
    expect(json.accepted).toBe(2);
    expect(json.rejected).toBe(1);
    expect(json.results[1]!.ok).toBe(false);
    expect(json.results[1]!.error).toContain("status");
    expect(insertSpy).toHaveBeenCalledTimes(2); // only the two good events inserted
  });

  it("preserves the Memex auth boundary — a cross-Memex event is rejected in-batch, neighbours unaffected (ac-5)", async () => {
    tagAc(`${AC489}/ac-5`);
    // Force the FIRST event to resolve to a Memex the key does not authorise.
    vi.mocked(resolveMemexId).mockResolvedValueOnce("some-other-memex");
    const res = await postBatch([
      ev({ test_identifier: "cross" }),
      ev({ test_identifier: "ok1" }),
      ev({ test_identifier: "ok2" }),
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      accepted: number;
      rejected: number;
      results: Array<{ index: number; ok: boolean; error?: string }>;
    };
    expect(json.accepted).toBe(2);
    expect(json.rejected).toBe(1);
    expect(json.results[0]!.ok).toBe(false);
    expect(json.results[0]!.error).toContain("does not authorise");
    // Batching added no new cross-boundary write path: the rejected event never inserted.
    expect(insertSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-array events body and an oversized batch with 400, inserting nothing (ac-5 boundary)", async () => {
    tagAc(`${AC489}/ac-5`);
    const notArray = await postBatch("nope");
    expect(notArray.status).toBe(400);

    const oversized = await postBatch(
      Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => ev()),
    );
    expect(oversized.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("a batched event stores a row identical to a single POST (ac-5 — same meaning)", async () => {
    tagAc(`${AC489}/ac-5`);
    const captured: Array<Record<string, unknown>> = [];
    insertSpy.mockReturnValue({
      values: (v: Record<string, unknown>) => {
        captured.push(v);
        return {
          returning: vi
            .fn()
            .mockResolvedValue([{ id: "fake-uuid", createdAt: new Date() }]),
        };
      },
    });
    const one = ev({
      test_identifier: "same.ts::t",
      actor: "wic@mindset.ai",
      metadata: { branch: "main" },
    });
    const res = await postBatch([one]);
    expect(res.status).toBe(200);
    const row = captured[0]!;
    expect(row.subjectRef).toBe(one.ac_uid);
    expect(row.status).toBe("pass");
    expect(row.testIdentifier).toBe("same.ts::t");
    expect(row.actor).toBe("wic@mindset.ai");
    expect(row.hidden).toBe(false);
    expect(row.metadata).toEqual({ branch: "main" });
  });
});
