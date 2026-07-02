// spec-300 t-15 (dec-23, ac-51): unit tests for buildSkillsContext — the skills
// agent's grounding. It lists the Memex's active Skills (handle, name, capability
// flags, ref, description) so the agent grounds drafting / curation in what
// actually exists. We mock listSkills so the summary shape is asserted without
// touching the DB (mirrors context-builder.drift.test.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

vi.mock("../services/skills/skills-service.js", () => ({
  listSkills: vi.fn(),
}));

import { buildSkillsContext } from "./context-builder.js";
import { listSkills } from "../services/skills/skills-service.js";

// spec-300 t-15: the skills-agent mode is grounded per-request in the Memex's
// skill catalogue by buildSkillsContext.
const AC_SKILLS_GROUNDING =
  "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-51";

type Skill = Awaited<ReturnType<typeof listSkills>>[number];

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    ref: "mindset-prod/memex-building-itself/skills/skill-1",
    handle: "skill-1",
    name: "pdf-extractor",
    description: "Use when: extracting text from a PDF.",
    capabilities: { codebaseAccess: false, codeEditing: false, externalTools: false },
    ...overrides,
  } as Skill;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildSkillsContext", () => {
  it("lists each active skill with handle, name, ref, description, and capability flags", async () => {
    tagAc(AC_SKILLS_GROUNDING);
    vi.mocked(listSkills).mockResolvedValueOnce([
      skill(),
      skill({
        ref: "mindset-prod/memex-building-itself/skills/skill-2",
        handle: "skill-2",
        name: "repo-auditor",
        description: "Use when: auditing a codebase.",
        capabilities: { codebaseAccess: true, codeEditing: false, externalTools: true },
      }),
    ]);

    const result = await buildSkillsContext("mx-uuid");

    expect(result.phase).toBe("specify");
    expect(result.context).toContain("Skills in this Memex: 2.");
    // Each skill leads with its handle + name and carries its ref + description.
    expect(result.context).toContain('- skill-1 "pdf-extractor"');
    expect(result.context).toContain(
      "ref: mindset-prod/memex-building-itself/skills/skill-1",
    );
    expect(result.context).toContain("Use when: extracting text from a PDF.");
    // Capability flags surface for a skill that declares them.
    expect(result.context).toContain(
      '- skill-2 "repo-auditor" [codebase-access, external-tools]',
    );
    // The authoring guidance names the one verbed write path the UI + MCP share.
    expect(result.context).toContain("update_skill");
    expect(listSkills).toHaveBeenCalledWith("mx-uuid");
  });

  it("returns an explicit 'no skills yet' context when the Memex has none", async () => {
    tagAc(AC_SKILLS_GROUNDING);
    vi.mocked(listSkills).mockResolvedValueOnce([]);

    const result = await buildSkillsContext("mx-uuid");
    expect(result.phase).toBe("specify");
    expect(result.context).toContain("Skills: none yet.");
    // Must not claim a phantom catalogue count.
    expect(result.context).not.toContain("Skills in this Memex:");
  });
});
