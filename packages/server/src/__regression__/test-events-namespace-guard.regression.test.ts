// spec-90 dec-7 (A1) — POST /api/test-events has NO server-owned-namespace
// guard. The per-memex emission-key match (spec-129) is the sole identity gate.
//
// Covers (reversed from the original b-90 Fix-4 commitments):
//   ac-5: a cross-namespace ref is ACCEPTED when the emission key authorises the
//         memex named in the ref; rejected 401 only when the key does not.
//   ac-7: no MEMEX_OWN_NAMESPACE gate — a request never 4xx/503s because a
//         server-owned namespace is unset or mismatched.
//   ac-8: the server constructs no `wrong-namespace` / `missing-config` error
//         shape for test-event ingestion.
//
// Built against the Hono route handler directly via app.request(), with the DB
// and emission-key auth layers mocked. The headline case is the Agent Craft
// scenario (issue-1): a tenant on its own namespace, holding its own key, lands.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";

// Mock the DB layer so the route's insert calls don't hit a real database.
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
    transaction: (cb: (tx: { insert: () => unknown }) => unknown) =>
      cb({ insert: () => insertSpy() }),
  },
}));

vi.mock("../services/test-event-latest.js", () => ({
  applyEmissionToSummary: vi.fn().mockResolvedValue(undefined),
}));

// Mutate() is exercised here only as a pass-through wrapper around the insert.
vi.mock("../services/mutate.js", () => ({
  mutate: vi.fn(
    async (_ctx: unknown, _key: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

vi.mock("../services/spec-traffic.js", () => ({
  observeTestEventTraffic: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  maybeAutoResolveIssuesForAcUid: vi.fn().mockResolvedValue(undefined),
}));

// spec-129: the route requires a valid emission key whose memexId matches the
// memex named in the ref. Default: key authorises memex-1 and resolveMemexId
// returns memex-1 (a match). Individual tests override resolveMemexId to model
// a key that does NOT authorise the named memex.
vi.mock("../services/emission-keys.js", () => ({
  verifyEmissionKey: vi.fn().mockResolvedValue({ id: "key-1", memexId: "memex-1" }),
  resolveMemexId: vi.fn().mockResolvedValue("memex-1"),
  bumpLastUsed: vi.fn(),
}));

import { testEventsRouter } from "../routes/test-events.js";
import { resolveMemexId } from "../services/emission-keys.js";

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

let priorOwn: string | undefined;

beforeEach(() => {
  // The env var must be irrelevant now; capture + clear it to prove the route
  // ignores it entirely.
  priorOwn = process.env.MEMEX_OWN_NAMESPACE;
  delete process.env.MEMEX_OWN_NAMESPACE;
  insertSpy.mockClear();
  vi.mocked(resolveMemexId).mockResolvedValue("memex-1");
});

afterEach(() => {
  if (priorOwn === undefined) {
    delete process.env.MEMEX_OWN_NAMESPACE;
  } else {
    process.env.MEMEX_OWN_NAMESPACE = priorOwn;
  }
});

const validBody = (acUid: string) => ({
  ac_uid: acUid,
  status: "pass",
  test_identifier: "tests/regression.test.ts::it works",
  duration_ms: 12,
});

const post = (acUid: string) =>
  app.request("/api/test-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
    body: JSON.stringify(validBody(acUid)),
  });

describe("spec-90 ac-7: no MEMEX_OWN_NAMESPACE gate (fail-closed branch removed)", () => {
  it("accepts a request even though MEMEX_OWN_NAMESPACE is unset (no 503)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-7");
    // env var deleted in beforeEach
    const res = await post("agent-craft/agentcraft/specs/spec-37/acs/ac-7");
    expect(res.status).toBe(201);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("never returns 503 for test-event ingestion regardless of server config", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-7");
    const res = await post("mindset-prod/memex-app/specs/spec-1/acs/ac-1");
    expect(res.status).not.toBe(503);
  });
});

describe("spec-90 ac-8: no wrong-namespace / missing-config error shapes", () => {
  it("a cross-namespace ref does not produce a wrong-namespace error body", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-8");
    // A ref whose namespace differs from anything the server might think it
    // 'owns'. Pre-A1 this returned 400 wrong-namespace; now it is accepted.
    const res = await post("agent-craft/agentcraft/specs/spec-37/acs/ac-7");
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(201);
    expect(body.error).toBeUndefined();
  });

  it("the route source contains neither error shape", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-8");
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../routes/test-events.ts", import.meta.url)),
      "utf8",
    );
    // Only the explanatory comment may mention the words; no JSON error literal.
    expect(src).not.toMatch(/error:\s*["']wrong-namespace["']/);
    expect(src).not.toMatch(/error:\s*["']missing-config["']/);
  });
});

describe("spec-90 ac-5: cross-namespace events accepted when the key authorises the memex", () => {
  it("accepts a tenant's own-namespace ref with a key that authorises it (the Agent Craft case)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-5");
    // ac-15 (customer outcome): the server half — a tenant on its own namespace,
    // with a key minted in that memex, lands. No per-tenant server config.
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-15");
    // resolveMemexId -> memex-1 == key.memexId (default). agent-craft != any
    // server namespace, yet it is accepted: no namespace-equality comparison.
    const res = await post("agent-craft/agentcraft/specs/spec-37/acs/ac-7");
    expect(res.status).toBe(201);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects 401 when the key does NOT authorise the memex named in the ref", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-5");
    // Key is for memex-1, but the ref's memex resolves to a different id.
    vi.mocked(resolveMemexId).mockResolvedValue("memex-OTHER");
    const res = await post("agent-craft/agentcraft/specs/spec-37/acs/ac-7");
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(401);
    expect(body.error).toBe("unauthorized");
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("rejects 401 when the ref's memex does not resolve at all", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-5");
    vi.mocked(resolveMemexId).mockResolvedValue(null);
    const res = await post("agent-craft/nonexistent/specs/spec-1/acs/ac-1");
    expect(res.status).toBe(401);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
