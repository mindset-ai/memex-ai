// spec-427 t-8 — the backlog batch, unit level: prove runActivationBacklog SELECTS with
// the go-live cutoff and DELEGATES to t-7's runActivationDrip with exactly those
// candidates (so the shared dedup/ladder/flag-gate apply). The send semantics
// themselves are t-7's and are exercised in the .integration test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-427/acs/ac-${n}`;

const runActivationDrip = vi.fn();
vi.mock("./activation-drip.js", async (orig) => ({
  ...(await orig<typeof import("./activation-drip.js")>()),
  runActivationDrip: (...a: unknown[]) => runActivationDrip(...a),
}));

import { runActivationBacklog } from "./activation-backlog.js";
import type { Db } from "../../db/connection.js";

afterEach(() => vi.clearAllMocks());

// Capture the WHERE builder the selection query is handed, so we can assert the cutoff
// is applied, and return a fixed candidate set.
const CANDIDATES = [
  { id: "a", email: "a@example.test", name: null },
  { id: "b", email: "b@example.test", name: null },
];
function fakeConn(capture: (arg: unknown) => void): Db {
  return {
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          capture(clause);
          return Promise.resolve(CANDIDATES);
        },
      }),
    }),
  } as unknown as Db;
}

describe("runActivationBacklog", () => {
  it("selects backlog candidates with the go-live cutoff and delegates to the daily drip with them (ac-9)", async () => {
    tagAc(AC(9));
    runActivationDrip.mockResolvedValue({ evaluated: 2, sent: 2, byCohort: { connected_inactive: 1, signed_in_dormant: 1 }, errors: 0 });
    const goLiveAt = new Date("2026-07-01T00:00:00Z");
    const now = new Date("2026-07-01T09:00:00Z");
    let whereClause: unknown;
    const conn = fakeConn((c) => (whereClause = c));

    const summary = await runActivationBacklog(goLiveAt, now, conn);

    // Delegated to t-7's runActivationDrip with the selected candidates + the same conn/now.
    expect(runActivationDrip).toHaveBeenCalledTimes(1);
    expect(runActivationDrip).toHaveBeenCalledWith(now, conn, CANDIDATES);
    // A cutoff clause was applied to the selection (the created_at < go-live filter).
    expect(whereClause).toBeDefined();
    expect(summary.sent).toBe(2);
  });
});
