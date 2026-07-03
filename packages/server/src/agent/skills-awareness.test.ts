// spec-300 t-7 (dec-2 / dec-20, ac-24 / ac-41 / ac-3) — the in-app agent is
// skills-AWARE but has NO skill-execution path, and its prompt tells it to FOLLOW
// the skills it can satisfy and HAND OFF (render_handoff) the ones whose capability
// flags exceed it. Pure unit checks over the tool surface + the composed prompt —
// no LLM, no DB.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { getToolDefinitions } from "./tools.js";
import { buildSystemBlocks } from "./system-prompt.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

describe("in-app agent has no skill-execution tool (ac-24)", () => {
  it("exposes the skill READ tools but no tool that executes a skill/code", () => {
    tagAc(AC(24));
    const names = getToolDefinitions().map((t) => t.name);

    // The agent can DISCOVER and READ skills…
    expect(names).toContain("list_skills");
    expect(names).toContain("get_skill");

    // …but there is NO execution path: no run/execute/eval/bash/shell/sandbox tool.
    const executionish = names.filter((n) =>
      /(^|_)(run|exec|execute|eval|bash|shell|sandbox|invoke_skill|run_skill)($|_)/i.test(n),
    );
    expect(executionish).toEqual([]);
    // Belt-and-braces: no tool whose name pairs "skill" with an execution verb.
    expect(names.some((n) => /skill.*(run|exec|execute)|(run|exec|execute).*skill/i.test(n))).toBe(false);
  });

  it("offers render_handoff so a capability-exceeding skill routes to the coding agent", () => {
    tagAc(AC(41));
    const names = getToolDefinitions().map((t) => t.name);
    expect(names).toContain("render_handoff");
  });
});

describe("in-app agent prompt: discover-by-description + capability handoff (ac-3 / ac-41)", () => {
  const primaryPrompt = () =>
    buildSystemBlocks("Doc context here.", "build")
      .map((b) => b.text)
      .join("\n\n");

  it("instructs discovery by description and following a skill as a procedure without executing code (ac-3)", () => {
    tagAc(AC(3));
    const prompt = primaryPrompt();
    expect(prompt).toContain("## Skills");
    expect(prompt.toLowerCase()).toContain("description");
    expect(prompt.toLowerCase()).toMatch(/follow it as a (step-by-step )?procedure/);
    expect(prompt.toLowerCase()).toContain("get_skill");
    expect(prompt.toLowerCase()).toContain("never run code");
  });

  it("instructs handoff via render_handoff when a skill's capability flags exceed the agent (ac-41)", () => {
    tagAc(AC(41));
    const prompt = primaryPrompt();
    expect(prompt).toContain("render_handoff");
    expect(prompt.toLowerCase()).toContain("exceed");
    // The flags that force a handoff are named so the model can route on them.
    expect(prompt).toContain("code-editing");
    expect(prompt).toContain("codebase-access");
    expect(prompt).toContain("external-tools");
  });

  it("does NOT inject skills guidance into the scoped/scaffold agents (only the primary doc agent carries it)", () => {
    tagAc(AC(3));
    // Scaffold and the scoped standards/issues agents have narrow, non-skills jobs.
    const scaffold = buildSystemBlocks("ctx", "build", false, false, false, undefined, true)
      .map((b) => b.text)
      .join("\n\n");
    const standards = buildSystemBlocks("ctx", "build", false, false, false, undefined, false, "standards")
      .map((b) => b.text)
      .join("\n\n");
    expect(scaffold).not.toContain("## Skills — reusable procedures");
    expect(standards).not.toContain("## Skills — reusable procedures");
  });
});
