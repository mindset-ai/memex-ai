// spec-300 t-7 (dec-9, ac-21) — a non-technical author describes a Skill in plain
// language and the agent produces AND validates a spec-compliant SKILL.md. Pure
// unit test with an injected Anthropic client double (no live LLM): asserts the
// returned SKILL.md is skills-ref-valid, round-trips, and that a first invalid
// draft is repaired on the retry pass.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { draftSkillFromDescription } from "./draft-skill.js";
import { parseSkillMd } from "./parse-skill-md.js";
import { validateSkill } from "./validate-skill.js";
import { ValidationError } from "../../types/errors.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

/** A fake Anthropic client whose messages.create yields a queued emit_skill tool
 *  call per invocation — so we can script a valid draft, or invalid-then-valid. */
function fakeClient(
  drafts: ReadonlyArray<{ name: unknown; description: unknown; body: unknown }>,
): { client: Anthropic; calls: () => number } {
  let i = 0;
  const client = {
    messages: {
      create: async () => {
        const input = drafts[Math.min(i, drafts.length - 1)];
        i += 1;
        return {
          content: [
            { type: "tool_use", id: `tu_${i}`, name: "emit_skill", input },
          ],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => i };
}

describe("agent-assisted SKILL.md authoring (ac-21)", () => {
  it("drafts a skills-ref-valid SKILL.md from a plain-language description", async () => {
    tagAc(AC(21));
    const { client } = fakeClient([
      {
        name: "meeting-notes",
        description:
          "Turns a raw transcript into structured meeting notes. Use when: the user pastes a transcript.",
        body: "1. Read the transcript.\n2. Extract decisions and action items.\n3. Write a summary.",
      },
    ]);

    const drafted = await draftSkillFromDescription(
      "I want a skill that turns a meeting transcript into tidy notes with action items",
      { client },
    );

    // The returned SKILL.md passes the SAME validation the write paths run.
    expect(() => validateSkill(parseSkillMd(drafted.skillMd))).not.toThrow();
    // …and round-trips back to the authored fields.
    const parsed = parseSkillMd(drafted.skillMd);
    expect(parsed.name).toBe("meeting-notes");
    expect(parsed.description).toContain("Use when:");
    expect(drafted.name).toBe("meeting-notes");
  });

  it("repairs a first invalid draft on the retry pass and returns a valid SKILL.md", async () => {
    tagAc(AC(21));
    // First draft omits the required `description`; second is valid.
    const { client, calls } = fakeClient([
      { name: "broken-skill", description: "", body: "Body." },
      {
        name: "fixed-skill",
        description: "Does a thing. Use when: the user asks for the thing.",
        body: "1. Do the thing.",
      },
    ]);

    const drafted = await draftSkillFromDescription("a skill that does a thing", {
      client,
    });

    expect(calls()).toBe(2); // one repair pass fired
    expect(() => validateSkill(parseSkillMd(drafted.skillMd))).not.toThrow();
    expect(drafted.name).toBe("fixed-skill");
  });

  it("rejects a blank description before calling the model", async () => {
    tagAc(AC(21));
    const { client, calls } = fakeClient([
      { name: "x", description: "y. Use when: z.", body: "b" },
    ]);
    await expect(draftSkillFromDescription("   ", { client })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls()).toBe(0);
  });
});
