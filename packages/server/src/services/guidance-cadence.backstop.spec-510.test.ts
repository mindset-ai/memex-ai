// spec-510 t-9 — the volume backstop: guidance an agent can no longer see comes
// back (ac-3, and the half of ac-12 that had no test).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS THE MOST IMPORTANT TEST IN THE SPEC. Everything else here makes
// responses smaller. This is the one mechanism that stops smaller becoming
// blind. Suppression is permanent for a session unless the backstop fires: an
// agent whose context window has been trimmed no longer holds the guidance it
// was shown on call one, and without a refresh it would read a pointer to prose
// it can never recover, for the rest of a long session.
//
// FOUND MISSING WHILE CLOSING t-9. ac-12 was already reading VERIFIED, pinned by
// the integration test "emits static guidance in full on first sight, a pointer
// thereafter". That test proves the first half of ac-12's claim and never
// crosses the threshold, so the re-emit half — the actual safety property — was
// asserted by nothing. The AC was green on a test that could not fail for the
// reason the AC cares about. ac-3, the scope AC that states the same promise in
// the user's terms, was honestly untested.
//
// WHY A SERVICE-TIER TEST AND NOT ANOTHER INTEGRATION ONE. The threshold is
// 120,000 bytes — roughly twelve build-phase footers. Driving that through real
// tool calls would mean a dozen round trips to assert one boolean, and would
// still leave the arithmetic implicit. Here the volume is stated outright, which
// is also what lets the test say WHICH rule fired.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  CADENCE_REFRESH_BYTES,
  GUIDANCE_CADENCE_FLAG,
  composeCadencedGuidance,
  recordCadenceBytes,
} from "./guidance-cadence.js";
import type { GuidanceBlock } from "@memex/shared";

const AC_3 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-3";
const AC_12 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-12";

const POINTER_FRAGMENT = "guidance shown earlier this session";

function block(id: string, text: string): GuidanceBlock {
  return {
    kind: "guidance_block",
    id,
    source: "base",
    target: {},
    text,
    enabled: true,
    order: 1,
    rationale: "backstop fixture",
  };
}

const ALPHA = block("backstop-alpha", "ALPHA GUIDANCE BODY");
const BETA = block("backstop-beta", "BETA GUIDANCE BODY");

let previousFlag: string | undefined;
let key: string;
let keySeq = 0;

beforeEach(() => {
  previousFlag = process.env[GUIDANCE_CADENCE_FLAG];
  process.env[GUIDANCE_CADENCE_FLAG] = "1";
  // Per-test unique key [per std-37]: these run in parallel with everything else
  // and the claim row is keyed by session alone.
  key = `backstop-${process.pid}-${Date.now()}-${keySeq++}`;
});

afterEach(async () => {
  if (previousFlag === undefined) delete process.env[GUIDANCE_CADENCE_FLAG];
  else process.env[GUIDANCE_CADENCE_FLAG] = previousFlag;
  await db.execute(sql`DELETE FROM agent_session_claims WHERE session_id = ${key}`);
});

describe("spec-510 — a suppressed block returns once enough guidance has flowed past (ac-3, ac-12)", () => {
  it("re-emits in full after the byte threshold, and not before", async () => {
    tagAc(AC_3);
    tagAc(AC_12);

    // 1. First sight — full.
    const first = await composeCadencedGuidance(key, [ALPHA]);
    expect(first?.text).toContain("ALPHA GUIDANCE BODY");
    expect(first?.suppressed).toBe(0);

    // 2. Immediately after — suppressed, as the cadence intends.
    const second = await composeCadencedGuidance(key, [ALPHA]);
    expect(second?.text).not.toContain("ALPHA GUIDANCE BODY");
    expect(second?.text).toContain(POINTER_FRAGMENT);

    // 3. JUST UNDER the threshold — still suppressed. This is the half that
    //    makes the test mean something: without it, a backstop that fired on
    //    every call would pass step 4 just as happily, and the cadence would be
    //    saving nothing at all while looking correct.
    await recordCadenceBytes(key, CADENCE_REFRESH_BYTES - 1_000);
    const underThreshold = await composeCadencedGuidance(key, [ALPHA]);
    expect(
      underThreshold?.text,
      "The block came back before the threshold was reached — the backstop is " +
        "firing too eagerly, which silently undoes the saving this Spec exists for.",
    ).not.toContain("ALPHA GUIDANCE BODY");

    // 4. PAST the threshold — the agent gets its guidance back.
    await recordCadenceBytes(key, 2_000);
    const refreshed = await composeCadencedGuidance(key, [ALPHA]);
    expect(
      refreshed?.text,
      "The block did NOT come back after the threshold. An agent whose context " +
        "has been trimmed is now permanently reading a pointer to prose it can " +
        "no longer see — the one failure worse than verbosity (ac-3).",
    ).toContain("ALPHA GUIDANCE BODY");
    expect(refreshed?.suppressed).toBe(0);
  });

  it("the threshold is per block, so a block first seen later is not instantly due", async () => {
    tagAc(AC_12);
    // ac-12 says "measured per block, not globally". The cheap implementation —
    // one counter for the session — would refresh EVERY block the moment any one
    // of them aged out, which is the behaviour this asserts against.

    // ALPHA is claimed at 0 bytes.
    await composeCadencedGuidance(key, [ALPHA]);
    // A large volume flows, then BETA is seen for the first time. BETA's marker
    // is stamped at the CURRENT total, not at zero.
    await recordCadenceBytes(key, CADENCE_REFRESH_BYTES - 500);
    const betaFirst = await composeCadencedGuidance(key, [ALPHA, BETA]);
    expect(betaFirst?.text).toContain("BETA GUIDANCE BODY");

    // Now push past ALPHA's threshold but not past BETA's.
    await recordCadenceBytes(key, 1_000);
    const mixed = await composeCadencedGuidance(key, [ALPHA, BETA]);
    expect(
      mixed?.text,
      "ALPHA aged out and should be back in full.",
    ).toContain("ALPHA GUIDANCE BODY");
    expect(
      mixed?.text,
      "BETA was first shown recently and must stay suppressed — a shared counter " +
        "would have refreshed it alongside ALPHA.",
    ).not.toContain("BETA GUIDANCE BODY");
    // One pointer stands in for the suppressed set, never one per block.
    expect(mixed?.suppressed).toBe(1);
    expect(mixed?.text.match(new RegExp(POINTER_FRAGMENT, "g"))).toHaveLength(1);
  });

  it("is driven by BYTES, not by call count", async () => {
    tagAc(AC_12);
    // ac-12 is explicit: "driven by bytes rather than elapsed time or call count:
    // a session of many tiny calls does not trigger a re-emit". Many composures
    // that record nothing must leave the block suppressed.
    await composeCadencedGuidance(key, [ALPHA]);
    for (let i = 0; i < 25; i++) {
      await composeCadencedGuidance(key, [ALPHA]);
      await recordCadenceBytes(key, 10); // tiny responses
    }
    const stillSuppressed = await composeCadencedGuidance(key, [ALPHA]);
    expect(
      stillSuppressed?.text,
      "26 calls refreshed the block, so the backstop is counting CALLS. A chatty " +
        "session would then re-read the whole scaffold repeatedly and the Spec " +
        "would save nothing.",
    ).not.toContain("ALPHA GUIDANCE BODY");
  });
});
