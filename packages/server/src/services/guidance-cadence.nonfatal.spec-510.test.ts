// spec-510 — a claim-store failure must cost guidance DETAIL, never the whole
// footer. Round-1 review of PR #740, M-3.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS PINS. `composeCadencedGuidance` awaits `claimOnce` once per
// block — fourteen round trips on a verbose build read — and threw on failure.
// The seat's own try/catch is not a safety net for it: that catch returns
// `compose(withLead(undefined), undefined)`, i.e. a footer with NO guidance, NO
// handoff, NO acceptance-criteria nag, NO activity block and NO state line.
//
// So one pool timeout on one of fourteen upserts turned a response that should
// have carried guidance IN FULL into one carrying none at all — the exact
// inverse of the documented fallback, and strictly worse than the behaviour
// before this Spec. Nothing would have surfaced it: the tool call still
// succeeds, the payload is still correct, only the steering silently vanishes.
//
// TWO AWAITS, NOT ONE. The review named the claim loop. The key resolver is the
// same hazard and was not named: `ctx.cadenceKey()` on the in-app surface is
// `conversationCadenceKey` → `conversationIdFor` → a database read. A failure
// there reached the same catch with the same result.
//
// WHERE THE GUARD BELONGS. Inside the helpers, not as a wider try/catch at the
// seat [per std-51 — depth at the interface]. `composeCadencedGuidance` already
// owns "the cadence must not apply" and returns undefined for it; a store that
// cannot answer is that same case, so the contract absorbs it rather than
// growing a second one. A blanket catch at the seat would also swallow failures
// that SHOULD be loud.
//
// AND IT MUST BE LOUD IN THE LOG. Degrading silently is forbidden [per std-53,
// std-50, std-14]: the error OBJECT is logged, not a message string, so the
// stack survives to whoever reads `.logs/`.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import type { GuidanceBlock } from "@memex/shared";

const claimOnce = vi.fn();
const recordGuidanceBytes = vi.fn();
vi.mock("./session-claims.js", () => ({ claimOnce, recordGuidanceBytes }));

const { composeCadencedGuidance, recordCadenceBytes, GUIDANCE_CADENCE_FLAG } =
  await import("./guidance-cadence.js");

const AC_9 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-9";

function block(id: string, text: string): GuidanceBlock {
  return {
    kind: "guidance_block",
    id,
    source: "base",
    target: {},
    text,
    enabled: true,
    order: 1,
    rationale: "nonfatal fixture",
  };
}

const BLOCKS = [block("nf-a", "ALPHA BODY"), block("nf-b", "BETA BODY")];

let previousFlag: string | undefined;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  previousFlag = process.env[GUIDANCE_CADENCE_FLAG];
  process.env[GUIDANCE_CADENCE_FLAG] = "1";
  claimOnce.mockReset();
  recordGuidanceBytes.mockReset();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (previousFlag === undefined) delete process.env[GUIDANCE_CADENCE_FLAG];
  else process.env[GUIDANCE_CADENCE_FLAG] = previousFlag;
  // Restore rather than clear [per std-37]: a leaked console stub silences
  // every suite that runs after this one in the same worker.
  errorSpy.mockRestore();
});

describe("spec-510 — the cadence degrades to FULL guidance when its store cannot answer", () => {
  it("returns undefined (emit in full) instead of throwing", async () => {
    tagAc(AC_9);
    claimOnce.mockRejectedValue(new Error("pool timeout"));

    const result = await composeCadencedGuidance("nf-key", BLOCKS);

    // undefined is the established "cadence does not apply" signal — the caller
    // then projects exactly as it did before this Spec. Reusing it means the
    // failure path is the path that already has coverage, not a new one.
    expect(
      result,
      "A store failure must read as 'cadence does not apply', so the renderer " +
        "emits every block IN FULL. Throwing here empties the entire footer at " +
        "the seat — guidance, handoff, AC nag, activity and state line alike.",
    ).toBeUndefined();
  });

  it("logs the error OBJECT, so a degrade is never silent", async () => {
    tagAc(AC_9);
    const cause = new Error("pool timeout");
    claimOnce.mockRejectedValue(cause);

    await composeCadencedGuidance("nf-key", BLOCKS);

    expect(errorSpy).toHaveBeenCalled();
    const loggedTheObject = (errorSpy.mock.calls as unknown[][]).some((args) =>
      args.some((a) => a === cause),
    );
    expect(
      loggedTheObject,
      "The original Error object must reach the log, not a stringified message " +
        "— the stack is the only thing that says WHICH of fourteen claims failed.",
    ).toBe(true);
  });

  it("a failure part-way through does not emit a half set behind a pointer", async () => {
    tagAc(AC_9);
    // The nastiest shape: block one claims fine, block two's upsert dies. If the
    // loop caught per-block it would emit ALPHA plus a pointer standing in for
    // BETA — a response that looks like a correct cadence and silently drops a
    // block the session has never seen. All-or-nothing is the safe reading.
    claimOnce
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("pool timeout"));

    const result = await composeCadencedGuidance("nf-key", BLOCKS);
    expect(result).toBeUndefined();
  });

  it("still cadences normally when the store is healthy", async () => {
    tagAc(AC_9);
    // The guard must not swallow the feature: with claims granted the blocks
    // come through, and with them refused the pointer does. Without this, a
    // `return undefined` at the top of the function would pass everything above.
    claimOnce.mockResolvedValue(true);
    const all = await composeCadencedGuidance("nf-key", BLOCKS);
    expect(all?.text).toContain("ALPHA BODY");
    expect(all?.text).toContain("BETA BODY");
    expect(all?.suppressed).toBe(0);

    claimOnce.mockResolvedValue(false);
    const none = await composeCadencedGuidance("nf-key", BLOCKS);
    expect(none?.text).not.toContain("ALPHA BODY");
    expect(none?.suppressed).toBe(2);
  });

  it("recordCadenceBytes was already non-fatal and stays that way", async () => {
    tagAc(AC_9);
    // Asserted here so the two halves of the contract sit together: the byte
    // record was documented "never throws" from the start, and a future edit
    // that makes the claim path loud must not quietly make this one loud too.
    recordGuidanceBytes.mockRejectedValue(new Error("pool timeout"));
    await expect(recordCadenceBytes("nf-key", 1_234)).resolves.toBeUndefined();
  });
});
