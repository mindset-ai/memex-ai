// Regression guard: the MCP `instructions` field is delivered to clients via
// Claude Code's session-init mechanism, which truncates around the first
// ~2.9 KB of content. Anything past that point is invisible to the client.
// This was observed empirically: a long-running AC stanza added past the cap
// was dead text for every agent connecting via the MCP `instructions`
// channel, with no error or warning surfaced anywhere.
//
// The fix has two halves:
//   1. Operating depth lives behind `get_information` (a tool), not in the
//      instructions string. The instructions string carries only the
//      load-bearing rules + a pointer to that tool.
//   2. This test enforces that the load-bearing tokens stay before the cap,
//      so the silent-killer regression cannot return.
//
// If a future contributor pushes a load-bearing token past the cap, this
// test fails before the change can land — restructure the instructions
// rather than relaxing the test.

import { describe, it, expect } from "vitest";
import { MEMEX_AGENT_INSTRUCTIONS } from "../mcp/tools.js";

// Documented cap (https://code.claude.com/docs/en/mcp, section "Scale with
// MCP Tool Search → For MCP server authors"):
//
//   "Claude Code truncates tool descriptions and server instructions at
//    2KB each. Keep them concise to avoid truncation, and put critical
//    details near the start."
//
// That's ~2,048 bytes per field. Our guard caps at 1,750 — about 300 bytes
// of safety margin against implementation quirks (system-reminder framing
// overhead, character-vs-byte counting in the harness, future tightening
// without a docs update). Empirical observation against a 3,198-byte
// string confirmed truncation around byte ~2,039 in a fresh CC session,
// consistent with the documented 2KB cap.
//
// To verify the cap empirically: a brand-new CC session is required — the
// harness caches the MCP instructions handshake, so window reloads and
// even VS Code quits don't bust the cache. A fresh project / repository
// is the cleanest way to force a new handshake.
const CC_DELIVERY_CAP = 1750;

// Load-bearing tokens. Each one MUST appear in the surviving prefix or the
// agent is operating without that rule / pointer.
//
// Adding to this list is a deliberate act. Every new entry must:
//   1. Be load-bearing (the agent cannot do its job correctly without it).
//   2. Fit before the cap alongside the existing entries.
//
// If you find yourself wanting to add a long block of prose here: don't.
// Add a topic to `packages/server/src/guidance/` and reference it by name.
const REQUIRED_BEFORE_CAP: ReadonlyArray<{ token: string; reason: string }> = [
  { token: "list_memexes", reason: "First move — agent must know to discover memexes" },
  { token: "assess_spec", reason: "Phase-gate verb the agent runs before forward transitions" },
  { token: "get_information", reason: "Pointer to the on-demand guidance tool (depth lives there)" },
  { token: "non-negotiable", reason: "Heading for the rules section the agent must read" },
  { token: "Tasks only in `build`", reason: "Non-negotiable rule #1" },
  { token: "complete", reason: "Non-negotiable rule on task completion (verification must run)" },
];

describe("MEMEX_AGENT_INSTRUCTIONS — Claude Code truncation guard", () => {
  // Hard cap on the TOTAL string length. The whole instructions string
  // must fit inside the CC delivery budget — anything past it is dead
  // text for clients (the silent killer the get_information mechanism
  // exists to prevent in the first place). This is stricter than the
  // per-token check below: even if every load-bearing token is in the
  // surviving prefix, adding more prose past the cap is wasted bytes
  // that future contributors may mistake for delivered content.
  //
  // To grow the string beyond this cap, you must either:
  //   (a) move the new content into a get_information topic and let
  //       agents fetch it on demand, or
  //   (b) re-measure the cap empirically (fresh CC session, new
  //       project), revise CC_DELIVERY_CAP upward, and update this
  //       test alongside any restructure that re-validates against
  //       the new number.
  // Don't just bump the constant — measure first.
  it(`total length stays within the CC delivery cap (<= ${CC_DELIVERY_CAP} bytes; the entire string must fit)`, () => {
    expect(
      MEMEX_AGENT_INSTRUCTIONS.length,
      `MEMEX_AGENT_INSTRUCTIONS is ${MEMEX_AGENT_INSTRUCTIONS.length} bytes, exceeding the CC delivery cap of ${CC_DELIVERY_CAP}. ` +
        `Content past the cap is dead text — clients never see it. ` +
        `Move the addition into a get_information topic (packages/server/src/guidance/<slug>.json) and reference it via a short pointer here.`,
    ).toBeLessThanOrEqual(CC_DELIVERY_CAP);
  });

  for (const { token, reason } of REQUIRED_BEFORE_CAP) {
    it(`"${token}" appears before the CC delivery cap (${reason})`, () => {
      const idx = MEMEX_AGENT_INSTRUCTIONS.indexOf(token);
      expect(
        idx,
        `Load-bearing token "${token}" is missing from MEMEX_AGENT_INSTRUCTIONS entirely. ` +
          `Reason it must be present: ${reason}.`,
      ).toBeGreaterThan(-1);
      expect(
        idx,
        `Load-bearing token "${token}" lives at byte ${idx}, past Claude Code's ~${CC_DELIVERY_CAP}-byte ` +
          `delivery cap. Clients will not receive it. Either restructure MEMEX_AGENT_INSTRUCTIONS so ` +
          `this content lives earlier, or push it into a get_information topic and reference it from a ` +
          `shorter pointer that does fit. See packages/server/src/guidance/README.md for the why.`,
      ).toBeLessThan(CC_DELIVERY_CAP);
    });
  }
});
