// spec-567 t-4 (ac-7) — the timings ride the row that is already written.
//
// This Spec exists because a post-commit path grew expensive without anyone noticing.
// An instrument that quietly added a round trip to that same path would be the defect
// committing itself a second time, and nothing would catch it later except a guard that
// fails. So: `logRouting` writes ONCE, and the durations go inside that write.
//
// Pure — the db module is stubbed, so this asserts the number of writes the code issues,
// not what Postgres did with them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const values = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const insert = vi.hoisted(() => vi.fn(() => ({ values })));
const update = vi.hoisted(() => vi.fn());
const execute = vi.hoisted(() => vi.fn());

vi.mock("../db/connection.js", () => ({ db: { insert, update, execute } }));

const { logRouting } = await import("./facet-routing-log.js");
const { facetRoutingLog } = await import("../db/schema.js");

const SPEC = "mindset-prod/memex-building-itself/specs/spec-567";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const TIMINGS = {
  generateCandidates: 3,
  queryEmbedding: 340,
  semanticRemainder: 120,
  keylessDensity: 4,
  sectionDocs: 18,
  rerank: 760,
  implicatedSections: 40,
  total: 1300,
  unattributed: 15,
};

const RESULT = {
  surfaced: [],
  all: [{ handle: "std-53", title: "After a write commits", facetKeys: ["architecture"], score: 1, surfaced: true }],
  k: 10,
  rankerModel: "cohere:rerank-v3.5",
  timings: TIMINGS,
};

beforeEach(() => {
  vi.clearAllMocks();
  values.mockResolvedValue(undefined);
});

describe("the routing log still writes exactly once (spec-567 t-4, ac-7)", () => {
  it("issues one INSERT into facet_routing_log and no other write", async () => {
    tagAc(AC(7));
    await logRouting("m-1", `${SPEC}/tasks/t-4`, "task", "the deploy gate", ["architecture"], RESULT, "created");

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(facetRoutingLog);
    expect(values).toHaveBeenCalledTimes(1);
    // No second write of any shape — an UPDATE to "add the timings afterwards" would be
    // exactly the round trip this AC forbids.
    expect(update).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("carries the timings INSIDE that one write, beside the occasion", async () => {
    tagAc(AC(7));
    await logRouting("m-1", `${SPEC}/tasks/t-4`, "task", "the deploy gate", ["architecture"], RESULT, "created");

    const written = values.mock.calls[0][0] as { rankerParams: Record<string, unknown> };
    expect(written.rankerParams.occasion).toBe("created");
    expect(written.rankerParams.timings).toEqual(TIMINGS);
  });
});
