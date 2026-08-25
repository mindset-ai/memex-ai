// spec-533 t-3 (ac-11 … ac-16, ac-21) — the staleness advisory on the wire.
//
// THE TRIGGER NEEDS NO CODE, AND THAT IS THE POINT. `X-Memex-Warning` is set only
// on the single-event route; the batch route returns warnings as per-event BODY
// fields and sets no header at all. So a client able to receive a header-borne
// advisory IS, by construction, a client on the un-batched path. ac-2's guarantee
// that "clients that already batch hear nothing" is therefore STRUCTURAL — there
// is no version check to write, none to maintain, and none that can drift (dec-2).
//
// Do not be tempted to detect staleness from the payload instead: the current
// 0.3.1 helper sends only Content-Type and Authorization, and still uses the
// legacy `ac_uid` field, identically to the Dart hand-roll. Nothing on the wire
// separates old from new.
//
// WHY THE MESSAGE MUST NAME THE RANGE. spec-358 dec-3 declined an advisory on
// this exact header because its recipients "cannot act on a warning, so a header
// would be unactionable log noise". Actionability is the standing bar, and under
// 0.x caret rules `^0.2.0` cannot install ANY 0.3.x — so a reader told merely to
// "upgrade" runs npm update, sees nothing change, and believes it fixed. Naming
// the range is what makes this legitimate rather than noise.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// Literals inlined: vi.mock factories hoist above every const in the file.
const KEY_ID = "key-abcdef0123456789";
const MEMEX_ID = "memex-11111111-2222-3333";

vi.mock("../services/emission-keys.js", () => ({
  verifyEmissionKey: vi
    .fn()
    .mockResolvedValue({ id: "key-abcdef0123456789", memexId: "memex-11111111-2222-3333" }),
  resolveMemexId: vi.fn().mockResolvedValue("memex-11111111-2222-3333"),
  bumpLastUsed: vi.fn(),
}));

import { testEventsRouter, META_MAX_VALUE_CHARS } from "./test-events.js";
import {
  STALENESS_ADVISORY,
  DEFAULT_SAMPLE_ONE_IN,
  resolveAdvisoryConfig,
  shouldAdvise,
  composeWarning,
  __setAdvisoryRandomForTests,
} from "../services/emission-advisory.js";

const M = "mindset-prod/memex-building-itself/specs/spec-533/acs";
const AC_11 = `${M}/ac-11`;
const AC_12 = `${M}/ac-12`;
const AC_13 = `${M}/ac-13`;
const AC_14 = `${M}/ac-14`;
const AC_15 = `${M}/ac-15`;
const AC_16 = `${M}/ac-16`;
const AC_21 = `${M}/ac-21`;
const AC_2 = `${M}/ac-2`; // SCOPE: an un-batched client learns; batchers hear nothing
const AC_3 = `${M}/ac-3`; // SCOPE: the nudge cannot flood a CI log
const AC_4 = `${M}/ac-4`; // SCOPE: deciding costs nothing per event
const AC_6 = `${M}/ac-6`; // SCOPE: no credential, nothing tenant-identifying

const RAW_KEY = "mxk_notARealKeyJustForLabelAssertions";
const REF = "mindset-prod/memex-building-itself/specs/spec-533/acs/ac-1";
const RUN_ID = "run-constant-across-a-whole-suite";

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RAW_KEY}` },
    body: JSON.stringify(body),
  });
}

const single = (extra: Record<string, unknown> = {}) => ({
  ac_uid: REF,
  status: "pass",
  test_identifier: "spec-533/advisory::single",
  duration_ms: 1,
  run_id: RUN_ID,
  ...extra,
});

/** Metadata guaranteed to breach the per-value cap, so the dropped-keys warning fires. */
const overCap = () => ({
  metadata: { branch: "x".repeat(META_MAX_VALUE_CHARS + 10), commit: "abc123" },
});

/** Force the advisory on / off deterministically — the ac-21 seam. */
const always = () => __setAdvisoryRandomForTests(() => 0);
const never = () => __setAdvisoryRandomForTests(() => 0.999999);

beforeEach(() => {
  insertSpy.mockClear().mockReturnValue(defaultInsertResult());
  transactionSpy.mockClear();
  selectSpy.mockClear();
});

afterEach(() => {
  __setAdvisoryRandomForTests(null); // restore Math.random [per std-37]
});

describe("spec-533 t-3: the advisory rides the single-event route only [ac-11]", () => {
  it("a successful single POST can carry it in X-Memex-Warning", async () => {
    tagAc(AC_11);
    always();
    const res = await post("/api/test-events", single());
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Memex-Warning")).toContain("Un-batched");
  });

  it("the batch route sets NO header, even when the advisory would fire [ac-2]", async () => {
    tagAc(AC_11);
    tagAc(AC_2);
    always(); // the draw says yes; the route must still be silent
    const res = await post("/api/test-events/batch", {
      events: [single(), single()],
    });
    expect(res.status).toBe(200);
    // Structural, not enforced: this route has no header-setting code path at
    // all, so a batching client is not listening on that channel.
    expect(res.headers.get("X-Memex-Warning")).toBeNull();
  });

  it("no staleness text leaks into the batch route's per-event warning fields", async () => {
    tagAc(AC_11);
    always();
    const res = await post("/api/test-events/batch", {
      events: [single(overCap())],
    });
    const body = (await res.json()) as {
      results: Array<{ warning?: string }>;
    };
    const warnings = body.results.map((r) => r.warning ?? "").join(" ");
    expect(warnings).toMatch(/metadata keys dropped/i); // the existing one still works
    expect(warnings).not.toMatch(/Un-batched/i);
    expect(warnings).not.toMatch(/\^0\.2\.0/);
  });
});

describe("spec-533 t-3: the message is actionable for both populations [ac-12]", () => {
  it("names the target range and the caret trap that makes npm update useless", () => {
    tagAc(AC_12);
    // Without this clause the reader "fixes" it and nothing changes — the exact
    // defect the advisory reports, reproduced by the advisory itself.
    expect(STALENESS_ADVISORY).toMatch(/\^0\.3\./);
    expect(STALENESS_ADVISORY).toMatch(/\^0\.2\.0/);
    expect(STALENESS_ADVISORY).toMatch(/cannot install/i);
  });

  it("gives the hand-roller an action too — they have no range to bump", () => {
    tagAc(AC_12);
    // One wire, two populations it cannot distinguish. "Bump your dependency" is
    // wrong for someone with no dependency.
    expect(STALENESS_ADVISORY).toMatch(/hand-rolled/i);
    expect(STALENESS_ADVISORY).toMatch(/api\/test-events\/batch/);
  });

  it("points at an MCP tool, not a URL that can die like docs/examples did", () => {
    tagAc(AC_12);
    expect(STALENESS_ADVISORY).toMatch(/get_information/);
    expect(STALENESS_ADVISORY).not.toMatch(/https?:\/\//);
  });

  it("is one ASCII line, bounded in size — it is a header value", () => {
    tagAc(AC_12);
    expect(STALENESS_ADVISORY).not.toMatch(/[\r\n]/);
    // eslint-disable-next-line no-control-regex
    expect(STALENESS_ADVISORY).toMatch(/^[\x20-\x7E]+$/);
    expect(STALENESS_ADVISORY.length).toBeLessThan(400);
  });
});

describe("spec-533 t-3: the advisory carries no identity [ac-13]", () => {
  it("leaks neither the credential nor anything tenant-shaped [ac-6]", async () => {
    tagAc(AC_13);
    tagAc(AC_6);
    always();
    const res = await post("/api/test-events", single());
    const header = res.headers.get("X-Memex-Warning") ?? "";
    // The same property the sibling header on this route already guarantees
    // (emission-admission.api.test.ts asserts x-memex-emission-gate excludes the
    // key). A response header is echoed into CI logs that are retained and
    // broadly readable: a credential written once is a credential leaked.
    for (const forbidden of [
      RAW_KEY,
      RAW_KEY.slice(0, 12),
      KEY_ID,
      MEMEX_ID,
      "mindset-prod",
      "memex-building-itself",
      "spec-533",
    ]) {
      expect(header).not.toContain(forbidden);
    }
  });

  it("rides a successful 201 and cannot change the outcome", async () => {
    tagAc(AC_13);
    always();
    const withAdvisory = await post("/api/test-events", single());
    never();
    const without = await post("/api/test-events", single());
    expect(withAdvisory.status).toBe(201);
    expect(without.status).toBe(201);
    // Emission is telemetry. It must never be able to break CI — the rule that
    // makes it safe to enforce keys server-side at all.
  });
});

describe("spec-533 t-3: deciding costs nothing per event [ac-14]", () => {
  it("adds no transaction, no select, whether it fires or not [ac-4]", async () => {
    tagAc(AC_14);
    tagAc(AC_4);
    never();
    await post("/api/test-events", single());
    const quiet = { tx: transactionSpy.mock.calls.length, sel: selectSpy.mock.calls.length };

    transactionSpy.mockClear();
    selectSpy.mockClear();
    always();
    await post("/api/test-events", single());
    const loud = { tx: transactionSpy.mock.calls.length, sel: selectSpy.mock.calls.length };

    // spec-520 exists to REMOVE per-event cost from this route; buying some back
    // to deliver an advisory would be self-defeating (std-39). Counting the calls
    // is the only check that catches a lookup added "for diligence".
    expect(loud).toEqual(quiet);
    expect(loud.sel).toBe(0);
  });
});

describe("spec-533 t-3: sampling is per request, never per run [ac-15][ac-21]", () => {
  it("the same run_id yields both outcomes", async () => {
    tagAc(AC_15);
    // A run-derived sample makes a 10,000-test suite either flood or stay
    // silent, with nothing in between — strictly worse, and tempting precisely
    // because the payload already carries run_id.
    always();
    const a = await post("/api/test-events", single());
    never();
    const b = await post("/api/test-events", single());
    expect(a.headers.get("X-Memex-Warning")).toContain("Un-batched");
    expect(b.headers.get("X-Memex-Warning")).toBeNull();
  });

  it("fires at the configured rate over a driven sequence [ac-3]", () => {
    tagAc(AC_15);
    tagAc(AC_3);
    // The bound is calculable rather than hoped for: at 1-in-N, N draws spread
    // across [0,1) fire exactly once. That is what keeps ~197,000 events from
    // becoming ~197,000 log lines.
    const N = 500;
    const cfg = { sampleOneIn: N };
    let fired = 0;
    for (let i = 0; i < N; i++) {
      __setAdvisoryRandomForTests(() => i / N);
      if (shouldAdvise(cfg)) fired++;
    }
    expect(fired).toBe(1);

    // And a small sender is statistically silent — the volume floor, with no
    // state and no threshold anyone had to implement. Twenty draws spread
    // uniformly across [0,1) all land above 1/500, so a client sending twenty
    // single POSTs is never told. (Spread them across [0,1) and not across
    // [0, 20/N): dividing by N puts the smallest draw under the threshold by
    // construction, which measures the arithmetic rather than the floor.)
    const SMALL = 20;
    let firedSmall = 0;
    for (let i = 0; i < SMALL; i++) {
      __setAdvisoryRandomForTests(() => (i + 0.5) / SMALL);
      if (shouldAdvise(cfg)) firedSmall++;
    }
    expect(firedSmall).toBe(0);
    // The smallest draw is comfortably above the threshold — stated so the
    // margin is visible rather than implied.
    expect(0.5 / SMALL).toBeGreaterThan(1 / N);
  });

  it("takes its randomness from an injectable source [ac-21]", () => {
    tagAc(AC_21);
    // The seam is the whole reason the claims above are assertions rather than
    // observations. Without it, proving them means either bursting the ingest
    // path or verifying a configuration production does not run (dec-7).
    const seen: number[] = [];
    __setAdvisoryRandomForTests(() => {
      seen.push(1);
      return 0;
    });
    shouldAdvise({ sampleOneIn: 2 });
    expect(seen.length).toBe(1);
  });

  it("defaults to 1-in-500 and reads MEMEX_EMISSION_* for the override [ac-15]", () => {
    tagAc(AC_15);
    expect(DEFAULT_SAMPLE_ONE_IN).toBe(500);
    expect(resolveAdvisoryConfig({}).sampleOneIn).toBe(500);
    expect(
      resolveAdvisoryConfig({ MEMEX_EMISSION_ADVISORY_SAMPLE_ONE_IN: "50" }).sampleOneIn,
    ).toBe(50);
    // Garbage must not silently disable the bound.
    expect(
      resolveAdvisoryConfig({ MEMEX_EMISSION_ADVISORY_SAMPLE_ONE_IN: "banana" }).sampleOneIn,
    ).toBe(500);
    expect(
      resolveAdvisoryConfig({ MEMEX_EMISSION_ADVISORY_SAMPLE_ONE_IN: "0" }).sampleOneIn,
    ).toBe(500);
  });
});

describe("spec-533 t-3: coexistence with the dropped-keys warning [ac-16]", () => {
  it("puts both messages in ONE header, dropped-keys first", async () => {
    tagAc(AC_16);
    always();
    const res = await post("/api/test-events", single(overCap()));
    expect(res.status).toBe(201);

    // Hono's Headers.get() joins repeated values with ", " — so asserting a
    // single instance means asserting the value is not two concatenated copies.
    const header = res.headers.get("X-Memex-Warning") ?? "";
    expect(header).toMatch(/metadata keys dropped/i);
    expect(header).toMatch(/Un-batched/);
    // The specific fact about THIS emission before the general advisory about the
    // client's configuration.
    expect(header.indexOf("metadata keys dropped")).toBeLessThan(
      header.indexOf("Un-batched"),
    );
    expect(header).not.toMatch(/[\r\n]/);
  });

  it("leaves the dropped-keys behaviour untouched when the advisory does not fire", async () => {
    tagAc(AC_16);
    never();
    const res = await post("/api/test-events", single(overCap()));
    const header = res.headers.get("X-Memex-Warning") ?? "";
    // spec-358 dec-3 expressly preserved this warning — "distinct from the
    // existing metadata-dropped warning header, which stays as-is".
    expect(header).toMatch(/metadata keys dropped/i);
    expect(header).not.toMatch(/Un-batched/);
  });

  it("sets no header at all when neither applies", async () => {
    tagAc(AC_16);
    never();
    const res = await post("/api/test-events", single());
    expect(res.headers.get("X-Memex-Warning")).toBeNull();
  });

  it("composeWarning drops empties rather than emitting a bare separator", () => {
    tagAc(AC_16);
    expect(composeWarning([])).toBeNull();
    expect(composeWarning([null, undefined])).toBeNull();
    expect(composeWarning(["a", null, "b"])).toBe("a; b");
    expect(composeWarning([null, "only"])).toBe("only");
  });
});
