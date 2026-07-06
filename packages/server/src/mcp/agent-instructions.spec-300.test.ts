// spec-300 dec-26 (ac-68) — the MCP server instructions block carries the skills
// attunement, added net-neutrally by collapsing the redundant Pipeline recap into
// "Where the depth lives" (phase mechanics deferred to get_information('phases')).
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { MEMEX_AGENT_INSTRUCTIONS } from "./tools.js";

const AC_68 = "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-68";

describe("MEMEX_AGENT_INSTRUCTIONS skills attunement (ac-68)", () => {
  it("carries the skills-attunement instruction: local-miss → all_memexes → get_skill → follow", () => {
    tagAc(AC_68);
    expect(MEMEX_AGENT_INSTRUCTIONS).toContain("## Skills");
    expect(MEMEX_AGENT_INSTRUCTIONS).toContain("list_skills({all_memexes:true})");
    expect(MEMEX_AGENT_INSTRUCTIONS).toContain("get_skill(ref)");
    // The collision-ask rule rides along (mirrors the tool + plugin guidance).
    expect(MEMEX_AGENT_INSTRUCTIONS.toLowerCase()).toMatch(/name collides|collision/);
  });

  it("dropped the redundant Pipeline recap; phase mechanics deferred to get_information('phases')", () => {
    tagAc(AC_68);
    // The standalone "## Pipeline" heading is gone — its recap collapsed into the
    // depth pointer rather than re-listed inline.
    expect(MEMEX_AGENT_INSTRUCTIONS).not.toContain("## Pipeline");
    // The deferral pointer survives: depth (incl. the phase pipeline) lives behind
    // get_information, reachable via the explicit 'phases' topic. Nothing load-bearing lost.
    expect(MEMEX_AGENT_INSTRUCTIONS).toContain("get_information");
    expect(MEMEX_AGENT_INSTRUCTIONS).toContain("topic='phases'");
  });

  it("stays within the Claude Code delivery cap — the skills line is a lean net add, not bloat", () => {
    tagAc(AC_68);
    // The hard cap (instructions-truncation.regression.test.ts) is 1750 — content
    // past it is silently truncated. The skills attunement had to be paid for by
    // collapsing the Pipeline recap, keeping the whole block deliverable.
    expect(MEMEX_AGENT_INSTRUCTIONS.length).toBeLessThanOrEqual(1750);
  });
});
