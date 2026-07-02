import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { memexes } from "../../db/schema.js";
import { NotFoundError } from "../../types/errors.js";
import { makeTestMemex } from "../test-helpers.js";
import {
  createSkill,
  getSkill,
  listSkills,
  archiveSkill,
  restoreSkill,
} from "./skills-service.js";
import { formatSkillCatalogueAppendix } from "./skill-catalogue.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";

// spec-300 t-11 — archiving a Skill is NON-DESTRUCTIVE (ac-8) and reversible
// (ac-10). Archive hides the skill from both dispatch surfaces (listSkills and the
// agent skill catalogue) while preserving its content; restore re-surfaces it in
// both. Every mutation runs through the service (mutate()/std-8).

const ac = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

const SKILL_MD = reconstructSkillMd({
  name: "archivable-skill",
  description: "Archived then restored. Use when: exercising the archive lifecycle.",
  body: "# Archivable\n\nBody with a [per std-9] citation and steps.",
});

let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("skl-arch");
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, [memexId])).catch(() => {});
});

describe("archive is non-destructive + hidden from both dispatch surfaces (ac-8)", () => {
  it("hides an archived skill from listSkills AND the agent catalogue, preserving content", async () => {
    tagAc(ac(8));

    const created = await createSkill(memexId, {
      skillMd: SKILL_MD,
      capabilities: { codebaseAccess: true },
      files: [{ path: "notes.md", purpose: "author notes", text: "# Notes\nkeep me" }],
    });

    // Present in BOTH dispatch surfaces before archiving.
    expect((await listSkills(memexId)).some((s) => s.handle === created.handle)).toBe(true);
    expect(await formatSkillCatalogueAppendix(memexId)).toContain("archivable-skill");

    await archiveSkill(memexId, created.handle);

    // Gone from listSkills (MCP list_skills) ...
    expect((await listSkills(memexId)).some((s) => s.handle === created.handle)).toBe(false);
    // ... and from the agent's skill catalogue (the in-app dispatch surface).
    expect(await formatSkillCatalogueAppendix(memexId)).not.toContain("archivable-skill");
    // ... and a direct get is a 404 (archived is invisible, std-7).
    await expect(getSkill(memexId, created.handle)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("restore re-surfaces the archived skill in both surfaces (ac-10)", () => {
  it("restores an archived skill with its content fully preserved", async () => {
    tagAc(ac(8)); // content preservation (verified via the restored read)
    tagAc(ac(10)); // restore re-appears in list + catalogue

    const created = await createSkill(memexId, {
      skillMd: reconstructSkillMd({
        name: "restorable-skill",
        description: "Round-trips through archive. Use when: testing restore.",
        body: "# Restorable\n\nOriginal body, [per std-2].",
      }),
      capabilities: { externalTools: true },
      files: [{ path: "asset.txt", purpose: "bundled asset", text: "asset-bytes" }],
    });
    const originalMd = (await getSkill(memexId, created.handle)).skillMd;

    await archiveSkill(memexId, created.handle);
    expect((await listSkills(memexId)).some((s) => s.handle === created.handle)).toBe(false);

    // Restore un-archives it.
    const restored = await restoreSkill(memexId, created.handle);
    expect(restored.handle).toBe(created.handle);

    // Re-appears in listSkills ...
    expect((await listSkills(memexId)).some((s) => s.handle === created.handle)).toBe(true);
    // ... and in the agent catalogue ...
    expect(await formatSkillCatalogueAppendix(memexId)).toContain("restorable-skill");

    // ... with ALL content preserved: byte-faithful SKILL.md, capabilities, and the
    // auxiliary-file manifest survived the archive/restore round-trip untouched.
    const after = await getSkill(memexId, created.handle);
    expect(after.skillMd).toBe(originalMd);
    expect(after.capabilities).toEqual({
      codebaseAccess: false,
      codeEditing: false,
      externalTools: true,
    });
    expect(after.files.map((f) => f.path)).toEqual(["asset.txt"]);
  });

  it("restoring an already-active skill is idempotent", async () => {
    tagAc(ac(10));
    const created = await createSkill(memexId, {
      skillMd: reconstructSkillMd({
        name: "already-active",
        description: "Never archived. Use when: proving idempotency.",
        body: "Body.",
      }),
    });
    // No throw; the skill stays active and listable.
    await expect(restoreSkill(memexId, created.handle)).resolves.toBeTruthy();
    expect((await listSkills(memexId)).some((s) => s.handle === created.handle)).toBe(true);
  });

  it("restoring a cross-Memex / unknown handle is a 404 (std-7)", async () => {
    tagAc(ac(10));
    await expect(restoreSkill(memexId, "skill-999999")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
