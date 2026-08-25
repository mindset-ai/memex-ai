// spec-533 t-2 (ac-19) — emissions-per-request, counted AT INGEST.
//
// WHY NOT FROM THE DATABASE. `test_events` cannot answer this, and not because
// the window is short — there is no window. Retention is by COUNT, not age:
// RETENTION_KEEP = 10 per (subject_ref, test_identifier) (spec-398 dec-2),
// trimmed INSIDE the emission transaction rather than by a sweep someone could
// pause. And the table has no transport or route column, so even the ten
// surviving rows do not say which endpoint they arrived on. A busy test's
// history is therefore destroyed continuously, in proportion to how busy it is —
// the hottest consumers, the ones this Spec is about, lose theirs fastest.
// Reading the ratio back from the table is not a race against a clock; it is
// arithmetically impossible from what the table stores. spec-525's dec-6 became
// unanswerable on exactly this, which is why dec-3 makes deciding where the
// number lands a prerequisite of shipping rather than a follow-up.
//
// NOT NEW INSTRUMENTATION. spec-525's gate already carries these two units on
// this same route — WouldShedCount has eventsByCause AND requestsByCause, and its
// ac-13 states the rule: "the counter's unit is EMISSIONS LOST, not requests
// refused … one 429 can destroy 500 emissions while a per-request counter reads
// 1." This applies the identical split to ACCEPTED traffic.
//
// A separate file from test-events.test.ts on purpose: that file tags spec-115 /
// spec-333 / spec-489 criteria, an ephemeral key is scoped to ONE Spec, and a 401
// stops the rest of the flush — so mixing spec-533 tags in there could silently
// prevent these very emissions from ever being sent.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";

const defaultInsertResult = () => ({
  values: () => ({
    returning: () =>
      Promise.resolve([{ id: "evt-1", createdAt: new Date("2026-01-01T00:00:00Z") }]),
  }),
});

const insertSpy = vi.fn().mockReturnValue(defaultInsertResult());
const transactionSpy = vi.fn();
const selectSpy = vi.fn();

vi.mock("../db/connection.js", () => ({
  db: {
    insert: () => insertSpy(),
    select: (...args: unknown[]) => selectSpy(...args),
    transaction: (cb: (tx: { insert: () => unknown }) => unknown) => {
      transactionSpy();
      return cb({ insert: () => insertSpy() });
    },
  },
}));

vi.mock("../services/test-event-latest.js", () => ({
  applyEmissionToSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/test-event-retention.js", () => ({
  trimTestEventsForPair: vi.fn().mockResolvedValue(undefined),
  recordFirstVerified: vi.fn().mockResolvedValue(undefined),
}));

// Literals are inlined below rather than referenced: vi.mock factories are
// hoisted above every const in the file, so a top-level variable is not yet
// initialised when the factory runs.
const KEY_ID = "key-abcdef0123456789";
const MEMEX_ID = "memex-11111111-2222-3333";

vi.mock("../services/emission-keys.js", () => ({
  verifyEmissionKey: vi
    .fn()
    .mockResolvedValue({ id: "key-abcdef0123456789", memexId: "memex-11111111-2222-3333" }),
  resolveMemexId: vi.fn().mockResolvedValue("memex-11111111-2222-3333"),
  bumpLastUsed: vi.fn(),
}));

import { testEventsRouter } from "./test-events.js";
import { __emissionAcceptedProbe } from "../observability/otel/index.js";

const M = "mindset-prod/memex-building-itself/specs/spec-533/acs";
const AC_19 = `${M}/ac-19`;
const AC_5 = `${M}/ac-5`; // SCOPE: adoption provable as a ratio, not asserted

const RAW_KEY = "mxk_notARealKeyJustForLabelAssertions";
const REF = "mindset-prod/memex-building-itself/specs/spec-533/acs/ac-1";

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RAW_KEY}` },
    body: JSON.stringify(body),
  });
}

const single = () => ({
  ac_uid: REF,
  status: "pass",
  test_identifier: "spec-533/ratio::single",
  duration_ms: 1,
});

const batchOf = (n: number) => ({
  events: Array.from({ length: n }, (_, i) => ({
    ac_uid: REF,
    status: "pass",
    test_identifier: `spec-533/ratio::batch-${i}`,
    duration_ms: 1,
  })),
});

beforeEach(() => {
  insertSpy.mockClear().mockReturnValue(defaultInsertResult());
  transactionSpy.mockClear();
  selectSpy.mockClear();
  __emissionAcceptedProbe.reset();
});

describe("spec-533 t-2: emissions-per-request is counted at ingest [ac-19]", () => {
  it("a single-event POST counts one event against one request, on the single route", async () => {
    tagAc(AC_19);
    const res = await post("/api/test-events", single());
    expect(res.status).toBe(201);

    expect(__emissionAcceptedProbe.snapshot()).toEqual({ events: 1, requests: 1 });
    expect(__emissionAcceptedProbe.byRoute()).toEqual({ single: 1 });
  });

  it("a batch POST counts its accepted length against ONE request, on the batch route", async () => {
    tagAc(AC_19);
    const res = await post("/api/test-events/batch", batchOf(8));
    expect(res.status).toBe(200);

    // The whole point: 8 emissions arrived, but the server was asked once. A
    // per-request counter alone would read 1 here and 8 for the un-batched
    // client — identical volume, opposite situations.
    expect(__emissionAcceptedProbe.snapshot()).toEqual({ events: 8, requests: 1 });
    expect(__emissionAcceptedProbe.byRoute()).toEqual({ batch: 8 });
  });

  it("the ratio separates an un-batched client from a batched one [ac-5]", async () => {
    tagAc(AC_19);
    tagAc(AC_5);
    // Un-batched: eight tests, eight requests.
    for (let i = 0; i < 8; i++) await post("/api/test-events", single());
    const unbatched = __emissionAcceptedProbe.snapshot();
    expect(unbatched.events / unbatched.requests).toBeCloseTo(1, 5);

    // Batched: the same eight emissions, one request.
    __emissionAcceptedProbe.reset();
    await post("/api/test-events/batch", batchOf(8));
    const batched = __emissionAcceptedProbe.snapshot();
    expect(batched.events / batched.requests).toBeCloseTo(8, 5);

    // And that is the whole signal: ratio ≈ 1 means one request per test.
    expect(batched.events / batched.requests).toBeGreaterThan(
      unbatched.events / unbatched.requests,
    );
  });

  it("carries route as its ONLY label — no credential, no tenant [ac-19]", async () => {
    tagAc(AC_19);
    await post("/api/test-events", single());
    await post("/api/test-events/batch", batchOf(2));

    expect(__emissionAcceptedProbe.labelKeys()).toEqual(["route"]);

    // The gate ahead of this route runs BEFORE authentication, so the set of
    // presented tokens is caller-controlled and unbounded — labelling one is a
    // cardinality problem an attacker can drive at will (spec-525 ac-14). Here
    // the reason is stronger still: nothing tenant-shaped belongs in a metric
    // that answers a question about client behaviour.
    const serialised = JSON.stringify({
      routes: __emissionAcceptedProbe.byRoute(),
      labels: __emissionAcceptedProbe.labelKeys(),
    });
    for (const forbidden of [RAW_KEY, KEY_ID, MEMEX_ID, "mindset-prod", "spec-533"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("adds no database round-trip per event [ac-19]", async () => {
    tagAc(AC_19);
    // spec-520 exists to REMOVE per-event cost from this route; buying some back
    // to deliver a metric would be self-defeating (std-39). One transaction per
    // event, and no extra select — counting the calls is the only check that
    // catches a lookup added "for diligence".
    await post("/api/test-events", single());
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).not.toHaveBeenCalled();

    transactionSpy.mockClear();
    await post("/api/test-events/batch", batchOf(5));
    expect(transactionSpy).toHaveBeenCalledTimes(5); // one per event, unchanged
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("is readable without reading test_events at all [ac-19]", async () => {
    tagAc(AC_19);
    // The counters answer the question from the request itself. Nothing in the
    // read path touches the table whose retention would have erased the answer.
    await post("/api/test-events/batch", batchOf(3));
    const { events, requests } = __emissionAcceptedProbe.snapshot();
    expect(events).toBe(3);
    expect(requests).toBe(1);
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
