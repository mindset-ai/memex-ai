// spec-562 ac-10 — what the caller is told when the deadline fires.
//
// This is the Spec's thesis, and the one thing it must not get wrong. The deadline
// does NOT cancel the query: Postgres keeps executing and the write may land after
// the caller has been answered. So the response asserts nothing about whether the
// write happened.
//
// These tests assert the ABSENCE of the misleading readings, not just the presence
// of the word "unknown". A response can say "unknown" and still tell an agent to
// retry — which is the failure this exists to prevent.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  dispatchTimeoutMessage,
  MCP_DISPATCH_DEADLINE_MS,
} from "./dispatch-deadline.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-562/acs/ac-${n}`;

const msg = () => dispatchTimeoutMessage("create_task");

describe("spec-562 — the UNKNOWN timeout response", () => {
  it("ac-10: states the outcome is unknown and names the tool", () => {
    tagAc(AC(10));
    const m = msg();
    expect(m).toMatch(/unknown/i);
    expect(m).toContain("create_task");
  });

  it("ac-10: sends the caller to READ BACK before retrying", () => {
    tagAc(AC(10));
    // The actionable instruction. Without it "unknown" is a shrug, and an agent
    // with no next step retries anyway.
    expect(msg()).toMatch(/read back/i);
  });

  it("ac-10: never claims the call failed or that nothing was written", () => {
    tagAc(AC(10));
    const m = msg().toLowerCase();
    // spec-560 dec-3 exists because an agent that cannot tell `created` from
    // `not created` either duplicates or silently drops. Reporting failure here
    // would be that defect relocated to a new seam — the Overview's one
    // must-not-get-wrong.
    for (const lie of [
      "failed",
      "the call failed",
      "nothing was written",
      "was not written",
      "no changes were made",
    ]) {
      expect(m, `the response claims "${lie}" — the write may still land`).not.toContain(lie);
    }
  });

  it("ac-10: never reads as a 429 — retrying is NOT presented as safe", () => {
    tagAc(AC(10));
    const m = msg().toLowerCase();
    // spec-332 dec-4's admission cap returns 429 + Retry-After, which means
    // NOTHING WAS DISPATCHED and a retry is safe. Both live on this seam. An agent
    // that conflates them retries a call that may already have written.
    for (const lie of [
      "safe to retry",
      "please retry",
      "try again",
      "retry the call",
      "retry-after",
    ]) {
      expect(m, `the response invites a blind retry ("${lie}")`).not.toContain(lie);
    }
    // And it says so positively, so the reader is not left to infer it.
    expect(m).toMatch(/do not retry blind|duplicate/i);
  });

  it("ac-10: the deadline it quotes is the one actually in force", () => {
    tagAc(AC(10));
    // DERIVED from the constant, never asserted as a literal: a hardcoded "30s"
    // here would pass while the copy lied, the day dec-2 is reopened.
    expect(msg()).toContain(`${Math.round(MCP_DISPATCH_DEADLINE_MS / 1000)}s`);
  });
});
