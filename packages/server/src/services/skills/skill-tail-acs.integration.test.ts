import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

// Force dev-mode auth on import so app.js builds without a configured OIDC client
// (same shape as routes/skills.integration.test.ts). We only inspect app.routes.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { memexes, documents } from "../../db/schema.js";
import { NotFoundError, ValidationError } from "../../types/errors.js";
import { makeTestMemex } from "../test-helpers.js";
import { createDocDraft } from "../documents.js";
import { parseHandleRefs } from "../clause-refs.js";
import { createSkill, getSkill, listSkills } from "./skills-service.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";
import { app } from "../../app.js";
import { toolManifest } from "@memex/shared";

// spec-300 t-11 — the remaining tail ACs:
//   ac-9  non-SKILL.md PRIMARY file rejected BEFORE parsing
//   ac-25 cross-Memex scoping (A's skill invisible to B)
//   ac-5  a Skill is a distinct artifact from a Standard, and may reference one
//   ac-30 a [per std-N] citation resolves as a back-reference; no uses_standards column
//   ac-27 both surfaces shipped under one spec — REST routes mounted + 3 MCP tools

const ac = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

let memexA: string;
let memexB: string;

beforeAll(async () => {
  memexA = await makeTestMemex("skl-tail-a");
  memexB = await makeTestMemex("skl-tail-b");
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, [memexA, memexB])).catch(() => {});
});

describe("non-SKILL.md primary rejected before parsing (ac-9)", () => {
  it("rejects a .txt primary with a user-visible error BEFORE parsing", async () => {
    tagAc(ac(9));

    // A filename that is NOT a SKILL.md, paired with content that would ALSO fail
    // to parse. If the guard fired at the right point the error names the filename,
    // proving the rejection happened BEFORE the parser ran.
    await expect(
      createSkill(memexA, { skillMd: "this is not valid frontmatter", filename: "notes.txt" }),
    ).rejects.toThrow(/must be a SKILL\.md/i);

    // A .json offered as the primary is likewise refused.
    await expect(
      createSkill(memexA, {
        skillMd: reconstructSkillMd({
          name: "json-primary",
          description: "Rejected. Use when: never.",
          body: "Body.",
        }),
        filename: "skill.json",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts a SKILL.md primary (case-insensitive, basename only) with any auxiliary types", async () => {
    tagAc(ac(9));

    // `path/to/SKILL.md` and `Skill.md` are both valid primaries; a binary
    // auxiliary alongside it is fine (auxiliaries may be any type).
    const created = await createSkill(memexA, {
      skillMd: reconstructSkillMd({
        name: "valid-upload",
        description: "Accepted upload. Use when: the primary is a SKILL.md.",
        body: "Body.",
      }),
      filename: "some/dir/Skill.md",
      files: [
        { path: "logo.png", purpose: "brand", contentType: "image/png", bytes: new Uint8Array([0x89, 0x50]) },
      ],
    });
    expect(created.name).toBe("valid-upload");
    expect(created.files.map((f) => f.path)).toEqual(["logo.png"]);
  });
});

describe("cross-Memex scoping (ac-25)", () => {
  it("a skill created in Memex A is not listed in, or gettable from, Memex B", async () => {
    tagAc(ac(25));

    const created = await createSkill(memexA, {
      skillMd: reconstructSkillMd({
        name: "scoped-to-a",
        description: "Lives only in A. Use when: never from B.",
        body: "Body.",
      }),
    });

    // Not in B's list ...
    expect((await listSkills(memexB)).some((s) => s.handle === created.handle)).toBe(false);
    // ... and not gettable from B (404, not 403 — std-7).
    await expect(getSkill(memexB, created.handle)).rejects.toBeInstanceOf(NotFoundError);
    // ... but present in A.
    expect((await listSkills(memexA)).some((s) => s.handle === created.handle)).toBe(true);
  });
});

describe("Skill is distinct from Standard and may reference one (ac-5, ac-30)", () => {
  it("stores a skill as docType 'skill', preserves a [per std-N] citation, and resolves it as a back-reference", async () => {
    tagAc(ac(5));
    tagAc(ac(30));

    // Seed a real Standard in Memex A — createDocDraft mints a std-N handle.
    const standard = await createDocDraft(
      memexA,
      "Tenant RLS posture",
      "Enable row-level security, never force it.",
      "standard",
    );
    expect(standard.handle).toMatch(/^std-\d+$/);

    // A Skill that CITES that Standard via the ordinary [per std-N] grammar.
    const skillMd = reconstructSkillMd({
      name: "rls-aware-skill",
      description: "Follows the RLS standard. Use when: touching tenant tables.",
      body: `# RLS-aware\n\nFollow this in conformance with [per ${standard.handle}].`,
    });
    const created = await createSkill(memexA, { skillMd });

    // ac-5 — the skill row is docType 'skill', DISTINCT from the standard's 'standard'.
    const [skillRow] = await db
      .select({ docType: documents.docType })
      .from(documents)
      .where(and(eq(documents.handle, created.handle), eq(documents.memexId, memexA)))
      .limit(1);
    expect(skillRow?.docType).toBe("skill");
    expect(skillRow?.docType).not.toBe("standard");

    // ac-30 — the [per std-N] citation is PRESERVED byte-faithfully on read ...
    const fetched = await getSkill(memexA, created.handle);
    expect(fetched.skillMd).toContain(`[per ${standard.handle}]`);

    // ... and RESOLVES as a back-reference through the platform's handle grammar:
    // parseHandleRefs (the same parser that materialises standards-network edges)
    // extracts it as a doc-level standard ref, and it resolves — memex-scoped — to
    // the real Standard's document id.
    const refs = parseHandleRefs(fetched.skillMd);
    const stdRef = refs.find((r) => r.handle === standard.handle);
    expect(stdRef).toEqual({ kind: "standard", handle: standard.handle, docLevel: true });

    const [resolved] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.handle, standard.handle), eq(documents.memexId, memexA)))
      .limit(1);
    expect(resolved?.id).toBe(standard.id);
  });

  it("has NO uses_standards column — the relationship lives in the prose, not a column", async () => {
    tagAc(ac(30));

    const rows = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'documents'
    `)) as unknown as { column_name: string }[];
    const columns = rows.map((r) => r.column_name);

    expect(columns.length).toBeGreaterThan(0); // sanity: the introspection returned real columns
    expect(columns).not.toContain("uses_standards");
    // And the Drizzle model carries no such property either.
    expect(Object.keys(documents)).not.toContain("usesStandards");
  });
});

describe("both surfaces shipped under one spec (ac-27)", () => {
  it("mounts the /skills REST routes AND registers the three MCP skill tools", () => {
    tagAc(ac(27));

    // In-app surface: the /skills REST routes are mounted on the app.
    const skillPaths = app.routes.map((r) => r.path).filter((p) => p.includes("/skills"));
    expect(skillPaths.length).toBeGreaterThan(0);
    // The list + single-skill routes both exist (mounted under the tenant prefix).
    expect(skillPaths.some((p) => p.endsWith("/skills") || p.endsWith("/skills/"))).toBe(true);
    expect(skillPaths.some((p) => p.includes("/skills/:handle"))).toBe(true);

    // MCP surface: exactly the three skill tools, declared in the @memex/shared manifest.
    const manifestNames = new Set(toolManifest.map((t) => t.name));
    expect(manifestNames.has("list_skills")).toBe(true);
    expect(manifestNames.has("get_skill")).toBe(true);
    expect(manifestNames.has("update_skill")).toBe(true);
    const skillTools = toolManifest.filter((t) => /^(list_skills|get_skill|update_skill)$/.test(t.name));
    expect(skillTools).toHaveLength(3);
  });
});
