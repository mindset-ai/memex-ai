// spec-560 t-1 (dec-1, dec-3) — a step that runs AFTER the commit must never report
// the write as failed.
//
// `storeRouteAndReadout` runs strictly after `createTask()` / `createDecision()` /
// `resolveDecision()` have committed (facet-consume.ts's own header states the ordering:
// the ballot's FK needs the row). Today a transient inside it throws out of the handler,
// so the caller is told `Unexpected server error` over a write that landed — the prod
// defect of 2026-09-10 (request 4a22f733, revision memex-api-00149-ffk).
//
// Pure by construction: the ballot store, the router and the routing log are all stubbed,
// so this drives the seam's FAILURE semantics without a DB. The happy path is already
// covered by facet-routing.integration.test.ts; what is asserted here is what the caller
// is TOLD when each half fails, and that neither half can throw.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-560";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

// ── stubs ────────────────────────────────────────────────────────────────────
const storeTaskBallot = vi.hoisted(() => vi.fn());
const storeDecisionBallot = vi.hoisted(() => vi.fn());
const routeFacets = vi.hoisted(() => vi.fn());
const formatRoutedStandards = vi.hoisted(() => vi.fn());
const logRouting = vi.hoisted(() => vi.fn());

vi.mock("./facet-ballot.js", () => ({
  storeTaskBallot,
  storeDecisionBallot,
  // Not the subject: a fixed non-empty facet set keeps the router reachable.
  trueFacetsOf: () => ["architecture"],
}));
vi.mock("./facet-routing.js", () => ({ routeFacets, formatRoutedStandards }));
vi.mock("./facet-routing-log.js", () => ({ logRouting }));

const { storeRouteAndReadout } = await import("./facet-consume.js");

// A vocabulary must be non-empty or the seam short-circuits to "" before doing any work.
const VOCAB = [{ key: "architecture", label: "Architecture", description: "" }] as never;

const READOUT = "\n2 standards govern this work…";

function args(over: Record<string, unknown> = {}) {
  return {
    memexId: "m-1",
    specDocId: "d-1",
    noun: "task" as const,
    rowId: "row-1",
    ownerRef: `${SPEC}/tasks/t-7`,
    queryText: "title\ndescription",
    ballot: { verdict: { architecture: true }, none: false },
    vocab: VOCAB,
    ctx: {},
    writeKind: "create" as const,
    ...over,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  storeTaskBallot.mockResolvedValue(undefined);
  storeDecisionBallot.mockResolvedValue(undefined);
  routeFacets.mockResolvedValue({ surfaced: [], all: [], k: 10, rankerModel: "keyless" });
  formatRoutedStandards.mockReturnValue(READOUT);
  logRouting.mockResolvedValue(undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

// The transient that actually happened in prod: a Cloud SQL socket connect failure
// surfacing out of mutate() -> resolveActorColumns, inside storeTaskBallot.
function connectTimeout() {
  return new Error("write CONNECT_TIMEOUT /cloudsql/memex-ai-prod:us-east4:memex-prod");
}

describe("spec-560: a post-commit step never reports the committed write as failed", () => {
  it("does not throw when the ballot store fails on a create — the row is already committed", async () => {
    tagAc(AC(12));
    storeTaskBallot.mockRejectedValue(connectTimeout());
    await expect(storeRouteAndReadout(args())).resolves.toBeTypeOf("string");
  });

  it("a create whose ballot store fails says CREATED, names the ref, and forbids a retry", async () => {
    tagAc(AC(12));
    tagAc(AC(2)); // scope: the loss is a named, repairable condition — not a 500.
    storeTaskBallot.mockRejectedValue(connectTimeout());

    const out = await storeRouteAndReadout(args());

    expect(out).toContain(`${SPEC}/tasks/t-7`);
    expect(out.toLowerCase()).toContain("created");
    // The negative instruction is load-bearing: an agent that has to INFER not to retry
    // from a cheerful message will sometimes infer wrong.
    expect(out.toLowerCase()).toMatch(/do not create it again/);
    // The repair must be a call it can make, and the verb is per-noun.
    expect(out).toContain("update_task");
    expect(out).not.toContain("update_decision");
  });

  it("names update_decision when the noun is a decision", async () => {
    tagAc(AC(12));
    storeDecisionBallot.mockRejectedValue(connectTimeout());

    const out = await storeRouteAndReadout(
      args({ noun: "decision", ownerRef: `${SPEC}/decisions/dec-3` }),
    );

    expect(out).toContain("update_decision");
    expect(out).not.toContain("update_task");
  });

  it("a recast whose ballot store fails says the classification is STALE, not absent", async () => {
    tagAc(AC(13));
    tagAc(AC(2)); // scope: "which loss occurred" — stale, not absent.
    storeDecisionBallot.mockRejectedValue(connectTimeout());

    const out = await storeRouteAndReadout(
      args({ noun: "decision", ownerRef: `${SPEC}/decisions/dec-3`, writeKind: "recast" }),
    );

    // decision_facet_ballots upserts one row per decision, so the PREVIOUS ballot still
    // stands. Saying it "could not be recorded" is true and actively misleading — the
    // agent goes looking for an absent ballot and finds a plausible wrong one (dec-3).
    expect(out).not.toContain("could not be recorded");
    expect(out.toLowerCase()).toMatch(/previous|still carries|stale/);
    expect(out.toLowerCase()).not.toMatch(/do not create it again/);
    expect(out.toLowerCase()).toMatch(/do not (repeat|resolve|update)/);
  });

  it("create and recast do not share one message — the occasion is read, never defaulted", async () => {
    tagAc(AC(13));
    storeTaskBallot.mockRejectedValue(connectTimeout());

    const onCreate = await storeRouteAndReadout(args({ writeKind: "create" }));
    const onRecast = await storeRouteAndReadout(args({ writeKind: "recast" }));

    // std-50: a value one component depends on and another owns is read or refused,
    // never defaulted in silence. A defaulted "create" would tell an update it created.
    expect(onCreate).not.toEqual(onRecast);
  });

  it("an advisory-only failure is invisible to the agent — byte-identical to clean success", async () => {
    tagAc(AC(14));
    // The ballot stored cleanly; only the routing/readout half failed. Nothing the agent
    // needed is lost, so it degrades in silence, matching the five precedents in s-3.
    routeFacets.mockRejectedValue(new Error("cohere upstream 503"));

    const out = await storeRouteAndReadout(args());

    expect(out).toBe("");
    expect(out).not.toContain("⚠");
  });

  it("a clean run is untouched — the readout still rides back", async () => {
    tagAc(AC(14));
    const out = await storeRouteAndReadout(args());
    expect(out).toBe(READOUT);
  });

  it("every swallowed failure reaches the operator with the original error AND its stack", async () => {
    tagAc(AC(15));
    const boom = connectTimeout();

    storeTaskBallot.mockRejectedValue(boom);
    await storeRouteAndReadout(args());

    storeTaskBallot.mockResolvedValue(undefined);
    routeFacets.mockRejectedValue(boom);
    await storeRouteAndReadout(args());

    expect(errorSpy).toHaveBeenCalledTimes(2);
    for (const call of errorSpy.mock.calls) {
      // The ERROR OBJECT, not String(err) — without the stack a real outage becomes
      // invisible in Cloud Logging, which is worse than the defect being fixed
      // (std-14, std-50; spec-257 dec-2 is the precedent).
      const logged = (call as unknown[]).find((a) => a instanceof Error) as Error | undefined;
      expect(logged).toBeInstanceOf(Error);
      expect(logged?.stack).toBeTruthy();
    }
  });
});
