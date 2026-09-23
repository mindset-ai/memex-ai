// spec-510 dec-14 (ac-29) — a third claim kind cannot be added without meeting
// the rule.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, AND WHY I FIRST ARGUED IT COULD NOT. ac-29 originally said it
// was "verified by reading, not by a test, and deliberately so" — a test
// asserting the two current key shapes would pin the EXAMPLES rather than the
// principle, which is the s-14 mistake this Spec has already made once.
//
// That reasoning was right about the wrong test. Asserting `handoff:` carries a
// user and `block:` does not pins the examples. Asserting the INVENTORY does
// not: it says nothing about either shape, and reds at exactly the moment the
// rule needs to be read — when someone writes a third kind.
//
// AND THE EXEMPTION WAS NOT AVAILABLE ANYWAY. The review asked whether a
// sign-off verb exists for an AC that can never go green. Checked, not assumed:
// none of the twelve `get_information` topics contains sign-off language, and
// the tool manifest has no verb for it (`override_done_gate` covers an
// unaccepted supersession, not AC verification). `get_information(topic=
// 'test-coverage')` is explicit the other way — "you should never reach verify
// with active ACs at 0 tests", and it rejects "wait for X" as an answer.
//
// So an AC that can never go green is a permanent line in the footer warning
// "⚠ N untested acceptance criteria" — the same warning I had stopped reading,
// which is how dec-11 sat naked for a full session. An untestable AC is not free;
// it spends the signal everything else depends on.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_29 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-29";

/**
 * The claim-key prefixes written into `agent_session_claims`, and the ONLY
 * thing this file asserts about them.
 *
 * Deliberately NOT their shapes. Whether `handoff:` carries a user is dec-14's
 * judgement applied to one case; freezing it here would make the rule
 * unfollowable — a future author obeying it correctly would red a test.
 */
const KNOWN_CLAIM_KINDS = ["handoff:", "block:"];

/** Sources that write a claim key. A new writer belongs in this list, and
 *  landing here is itself the prompt to read the rule. */
const WRITERS = [
  "handoff-delivery.ts",
  "guidance-cadence.ts",
];

describe("spec-510 dec-14 — the claim-key inventory is fixed until someone reads the rule (ac-29)", () => {
  it("only the two known claim kinds are written into the session row", () => {
    tagAc(AC_29);
    // Scanned from the writers rather than from a list of strings, so a kind
    // added in either file is caught whatever it is called.
    const found = new Set<string>();
    for (const file of WRITERS) {
      const src = readFileSync(join(__dirname, file), "utf8");
      // `claimOnce(key, \`prefix:...\`)` — the second argument's literal prefix.
      for (const m of src.matchAll(/claimOnce\([^,]+,\s*`([a-z][a-z0-9-]*):/g)) {
        found.add(`${m[1]}:`);
      }
      // …and the builders that return one rather than inlining it.
      for (const m of src.matchAll(/return\s+`([a-z][a-z0-9-]*):\$\{/g)) {
        found.add(`${m[1]}:`);
      }
    }

    expect(
      found.size,
      "No claim-key prefix was found at all — the scan has drifted from how " +
        "these keys are written, so this guard is asserting nothing.",
    ).toBeGreaterThan(0);

    const unknown = [...found].filter((k) => !KNOWN_CLAIM_KINDS.includes(k));
    expect(
      unknown,
      `A new claim kind is being written into agent_session_claims: ${unknown.join(", ")}\n\n` +
        "Before adding it to KNOWN_CLAIM_KINDS, read the rule at `claimOnce` in " +
        "session-claims.ts and decide whether this key carries the user:\n\n" +
        "  A claim whose loss is UNRECOVERABLE carries the user.\n" +
        "  A claim whose loss is RECOVERABLE does not.\n\n" +
        "Getting it wrong is silent in both directions — an over-scoped key " +
        "wastes a claim, an under-scoped one withholds something from someone " +
        "who never saw it, and `sessionId` is an unvalidated client header so " +
        "two users CAN collide on it.\n\n" +
        "This test does not check your key's SHAPE, deliberately: freezing the " +
        "two current shapes would make the rule unfollowable, since an author " +
        "obeying it correctly would red a test. It checks only that you were " +
        "made to read it.",
    ).toEqual([]);
  });

  it("the rule the failure message quotes is the rule that is written down", () => {
    tagAc(AC_29);
    // The message above restates the rule. If the rule moves and the message
    // does not, the next author reads a stale one from a failing test — the
    // dangling-citation shape this PR hit twice (round-10, round-11).
    const rule = readFileSync(join(__dirname, "session-claims.ts"), "utf8");
    expect(rule).toContain("A claim whose loss is UNRECOVERABLE carries the user");
    expect(rule).toContain("A claim whose loss is RECOVERABLE does not");
    // And the dependency that makes `block:` defensible must survive too — it is
    // the clause that turns this from a description into a rule with an expiry.
    expect(rule).toMatch(/recovery path ever stops working/i);
  });
});
