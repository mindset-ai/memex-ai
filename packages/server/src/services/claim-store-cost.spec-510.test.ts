// spec-510 ac-31 — the claim store's COST is asserted in CI, not only measured once.
//
// ac-31 supersedes ac-28 (c-19). ac-28 was a one-off PROCESS claim — "the dogfood
// measures the cost and the numbers land on the Spec" — and it held: s-16. These
// tests assert something ac-28 never said, the standing PROPERTIES of that cost, so
// they carry the criterion that says so rather than lending a verdict to one that
// does not. ac-28 keeps its statement and the emissions it earned.
//
// ac-28 existed because the cadence's saving and its cost ride the same path, and
// only the saving was being measured. The dogfood pass (Spec section s-16) found
// the cost side broken: an index on `updated_at` — a column every claim statement
// writes — made HOT updates structurally impossible, so every claim, including for
// a block the cadence SUPPRESSED, wrote a heap tuple plus an index entry and left
// both dead. Measured on int: 83 updates, 0 HOT. Fixed by migration 0153.
//
// A measurement taken once cannot catch that coming back. These two assertions can,
// and they are deliberately TWO, because each one is blind to what the other sees:
//
//   - the STATEMENT COUNT catches a change in how many round trips a response costs
//     (an N+1, a read added before every claim). It is blind to the 0152 defect:
//     adding an index changes what each statement costs, not how many there are.
//   - the HOT RATIO catches a change in what each statement costs — the 0152 defect
//     exactly, and any future cause of the same loss (an index on `claims` or
//     `guidance_bytes`, a trigger, a schema change). It is blind to round trips.
//
// Neither pins the dogfood's numbers. They pin the properties those numbers were
// evidence of.

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { sql } from "drizzle-orm";
import type { GuidanceBlock } from "@memex/shared";
import { db } from "../db/connection.js";
import {
  GUIDANCE_CADENCE_FLAG,
  composeCadencedGuidance,
  recordCadenceBytes,
} from "./guidance-cadence.js";

const AC_31 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-31";

function block(id: string): GuidanceBlock {
  return {
    kind: "guidance_block",
    id,
    source: "base",
    target: {},
    text: `${id} body`,
    enabled: true,
    order: 1,
    rationale: "claim-store cost fixture",
  };
}

const BLOCKS = ["cost-alpha", "cost-beta", "cost-gamma", "cost-delta"].map(block);

let previousFlag: string | undefined;
let key: string;

beforeEach(() => {
  previousFlag = process.env[GUIDANCE_CADENCE_FLAG];
  process.env[GUIDANCE_CADENCE_FLAG] = "1";
  // `session_id` is the primary key, so the key must be unique per worker AND per
  // call [per std-37 cl-1]: the pool id plus a UUID. `process.pid` is not enough —
  // under vitest's threads pool several workers share one pid.
  key = `claim-cost-${process.env.VITEST_POOL_ID ?? "0"}-${randomUUID()}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousFlag === undefined) delete process.env[GUIDANCE_CADENCE_FLAG];
  else process.env[GUIDANCE_CADENCE_FLAG] = previousFlag;
  await db.execute(sql`DELETE FROM agent_session_claims WHERE session_id = ${key}`);
});

async function tableCounters(): Promise<{ upd: number; hot: number }> {
  const rows = (await db.execute(sql`
    SELECT n_tup_upd AS upd, n_tup_hot_upd AS hot
    FROM pg_stat_user_tables WHERE relname = 'agent_session_claims'
  `)) as unknown as Array<{ upd: number | string; hot: number | string }>;
  return { upd: Number(rows[0]?.upd ?? 0), hot: Number(rows[0]?.hot ?? 0) };
}

describe("spec-510 ac-31 — the claim store's cost is asserted, not only measured", () => {
  it("costs exactly one statement per block per verbose response, suppressed or not, plus one byte record", async () => {
    tagAc(AC_31);
    const execute = vi.spyOn(db, "execute");

    // First sight: every block is claimed and emitted.
    const first = await composeCadencedGuidance(key, BLOCKS, "build");
    expect(first?.suppressed).toBe(0);
    const onFirstSight = execute.mock.calls.length;

    execute.mockClear();
    await recordCadenceBytes(key, 10_000);
    const perByteRecord = execute.mock.calls.length;

    // Repeat: every block is SUPPRESSED — and still costs a statement, because the
    // upsert's ELSE branch writes the row either way. This is the cost dec-13's
    // `claimMany` would remove; stating it here is what makes that trade visible.
    execute.mockClear();
    const repeat = await composeCadencedGuidance(key, BLOCKS, "build");
    expect(repeat?.suppressed).toBe(BLOCKS.length);
    const onRepeat = execute.mock.calls.length;

    const why =
      "The claim store's round trips per verbose response changed. Today it is ONE " +
      "statement per block (claimOnce) plus ONE per response (recordGuidanceBytes), " +
      "and a suppressed block costs the same statement as an emitted one.\n\n" +
      "If you are landing dec-13's batch (`claimMany`), this is the expectation to " +
      "change — deliberately, in the same commit, with the new count. If you are " +
      "not, something added a round trip to the hot path of every verbose tool " +
      "response: find it before changing this number.\n\n" +
      "Zero calls means the scan has drifted from how session-claims.ts talks to " +
      "the database (it no longer goes through db.execute) and this guard is " +
      "asserting nothing — re-point it rather than deleting it.";

    expect({ onFirstSight, onRepeat, perByteRecord }, why).toEqual({
      onFirstSight: BLOCKS.length,
      onRepeat: BLOCKS.length,
      perByteRecord: 1,
    });
  });

  it("keeps claim updates HOT — no index on a column the claim statements write", async () => {
    tagAc(AC_31);
    // ⚠ A TABLE-WIDE COUNT, deliberately, against std-37 cl-4's "scope counts to the
    // entity under test" — and the reason belongs here rather than being implied.
    // Postgres keeps HOT counters per TABLE; there is no per-row equivalent, and
    // `pageinspect` would need a superuser the test role does not have. What bounds
    // the contamination: every worker has its own database clone, and files within
    // a worker run one at a time, so the only foreign writes that can land in this
    // delta are a previous file's counters flushing late. Those can only LOWER the
    // ratio if they are non-HOT — i.e. only if the defect this test exists to catch
    // is already present — so the noise cannot turn a real failure green. The
    // update floor is `>=` for the same reason.
    const before = await tableCounters();

    // Create the row, then drive repeat responses. Each claimOnce is its own
    // statement and therefore its own transaction, which is what makes
    // `updated_at = now()` actually change value between writes — the property
    // production has and a single-transaction loop does not. (The first local A/B
    // of this ran inside one DO block, got the same now() for every UPDATE, and
    // read 92% HOT WITH the index. It looked like a refutation; it was the harness.)
    const RESPONSES = 8;
    for (let i = 0; i < RESPONSES; i++) {
      await composeCadencedGuidance(key, BLOCKS, "build");
      await recordCadenceBytes(key, 5_000);
    }
    // The first claim on a fresh session is the INSERT; everything after updates.
    const expectedUpdates = RESPONSES * (BLOCKS.length + 1) - 1;

    // Table statistics are published asynchronously: each backend flushes its
    // pending counters when it goes idle, at most once a second. Poll until the
    // updates this test made are visible [per std-37 — poll for async writes],
    // rather than reading once and asserting on a partial snapshot.
    let delta = { upd: 0, hot: 0 };
    await vi.waitFor(
      async () => {
        const now = await tableCounters();
        delta = { upd: now.upd - before.upd, hot: now.hot - before.hot };
        expect(delta.upd).toBeGreaterThanOrEqual(expectedUpdates);
      },
      { timeout: 20_000, interval: 250 },
    );

    const ratio = delta.hot / delta.upd;
    expect(
      ratio,
      `Only ${delta.hot} of ${delta.upd} claim updates were HOT (${(100 * ratio).toFixed(1)}%).\n\n` +
        "A HOT update keeps the new row version on the same page and skips every " +
        "index; Postgres allows it only when NO indexed column changed. The claim " +
        "statements write `claims`, `guidance_bytes` and `updated_at` on every call, " +
        "so an index covering any of them makes HOT impossible and every claim — " +
        "including for a SUPPRESSED block — writes a heap tuple plus index entries " +
        "and leaves both dead.\n\n" +
        "This is the exact defect migration 0152 shipped and 0153 removed (int " +
        "measured 83 updates, 0 HOT). Check `\\d agent_session_claims` for an index " +
        "on a written column. If issue-5's sweeper needs one on `updated_at`, the " +
        "sweeper has to find its rows another way, or this cost has to be decided " +
        "on out loud — not re-introduced as a side effect.",
    ).toBeGreaterThanOrEqual(0.8);
  }, 30_000);
});
