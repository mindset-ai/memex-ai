// spec-300 t-4 — integration tests for the three Skills MCP tools (list_skills,
// get_skill, verb-dispatched update_skill), exercised through the real handler +
// the real tenancy resolver (resolveWorkspaceForRead), over a seeded Memex.
//
// The handlers wrap the t-10 Skills service; these tests prove the tool surface:
// registration + std-16 manifest parity (ac-28), the list/read shapes (ac-32,
// ac-4), the create→edit→delete write round-trip + duplicate rejection (ac-31,
// ac-36, ac-20), and cross-Memex not-found tenancy (ac-11).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import {
  makeTestMemex,
  makeTestMemexWithDevAdmin,
} from "../services/test-helpers.js";
import { getUserByEmail } from "../services/users.js";
import {
  resolveWorkspaceForRead,
  McpAuthError,
  READ_ONLY_PUBLIC_MESSAGE,
} from "./auth.js";
import { skillsTools } from "../agent/handlers/skills.js";
import { toolSpecs, manifestVsSpecsDiff } from "../agent/tool-specs.js";
import type { ToolCtx, ToolSpec } from "../agent/handlers/tool-contract.js";
import { reconstructSkillMd } from "../services/skills/reconstruct-skill-md.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

// A 8-byte PNG signature — a stand-in "binary" auxiliary file.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

let memexA: string;
let nsA: string;
let userId: string;
let memexB: string;
let nsB: string;
let memexC: string;
let nsC: string;

const specByName = (name: string): ToolSpec => {
  const s = skillsTools.find((t) => t.name === name);
  if (!s) throw new Error(`skills tool ${name} not found`);
  return s;
};

/** Build a ctx that resolves the caller's Memex through the REAL read-gated
 *  resolver and applies the write gate exactly as mcp/tools.ts does — so tenancy
 *  (std-7) and the write gate (dec-15) are genuinely exercised, not stubbed. */
function realCtx(spec: ToolSpec): ToolCtx {
  return {
    userId,
    channel: "mcp",
    verbose: false,
    resolveMemex: async (memex?: string) => {
      const { memexId, readOnly } = await resolveWorkspaceForRead(
        userId,
        memex,
        undefined,
      );
      if (readOnly && !spec.annotations.readOnlyHint) {
        throw new McpAuthError(READ_ONLY_PUBLIC_MESSAGE);
      }
      return memexId;
    },
    resolveMemexFromEntity: async () => {
      throw new Error("resolveMemexFromEntity unused by skills tools");
    },
    resolveRef: async () => {
      throw new Error("resolveRef unused by skills tools");
    },
    workspaceUrl: async () => "",
  } as unknown as ToolCtx;
}

async function nsSlugFor(memexId: string): Promise<string> {
  const [row] = await db
    .select({ slug: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  return row!.slug;
}

const call = (name: string, input: Record<string, unknown>): Promise<string> =>
  specByName(name).handler(input, realCtx(specByName(name)));

beforeAll(async () => {
  const seeded = await makeTestMemexWithDevAdmin("skl-a");
  memexA = seeded.memexId;
  nsA = seeded.slug;
  const dev = await getUserByEmail("dev@memex.ai");
  userId = dev!.id;

  memexB = await makeTestMemex("skl-b");
  nsB = await nsSlugFor(memexB);

  // A SECOND Memex the caller (dev) administers — for the cross-Memex union.
  const seededC = await makeTestMemexWithDevAdmin("skl-c");
  memexC = seededC.memexId;
  nsC = seededC.slug;
});

afterAll(async () => {
  await db
    .delete(memexes)
    .where(inArray(memexes.id, [memexA, memexB, memexC]))
    .catch(() => {});
});

describe("skills MCP tools — registration + std-16 parity (ac-28)", () => {
  it("registers exactly three tools and the manifest ↔ specs parity holds", () => {
    tagAc(AC(28));
    const names = new Set(toolSpecs.map((t) => t.name));
    expect(names.has("list_skills")).toBe(true);
    expect(names.has("get_skill")).toBe(true);
    expect(names.has("update_skill")).toBe(true);

    // Exactly three skill-named tools — no per-verb create/edit/delete tools.
    const skillNamed = [...names].filter((n) => /skill/i.test(n)).sort();
    expect(skillNamed).toEqual(["get_skill", "list_skills", "update_skill"]);

    // update_skill is the single verb-dispatched write tool.
    expect(Object.keys(specByName("update_skill").schema)).toContain("verb");
    expect(specByName("update_skill").annotations.readOnlyHint).toBe(false);
    expect(specByName("list_skills").annotations.readOnlyHint).toBe(true);
    expect(specByName("get_skill").annotations.readOnlyHint).toBe(true);

    // The b-67 catalogue ↔ manifest cross-check: empty symmetric difference.
    const { inSpecsNotManifest, inManifestNotSpecs } = manifestVsSpecsDiff();
    expect({ inSpecsNotManifest, inManifestNotSpecs }).toEqual({
      inSpecsNotManifest: [],
      inManifestNotSpecs: [],
    });
  });
});

describe("list_skills / get_skill read shapes (ac-32, ac-4)", () => {
  it("list_skills returns name+description+capabilities, never body or allowed-tools (ac-32)", async () => {
    tagAc(AC(32));
    await call("update_skill", {
      verb: "create",
      memex: `${nsA}/main`,
      skill_md: reconstructSkillMd({
        name: "list-shape-skill",
        description: "Lists cleanly. Use when: reading a Memex's skills.",
        body: "BODYMARKER_LIST allowed-tools: Bash, Read",
      }),
      capabilities: { codebaseAccess: true },
    });

    const out = await call("list_skills", { memex: `${nsA}/main` });
    expect(out).toContain("list-shape-skill");
    expect(out).toContain("Lists cleanly. Use when: reading a Memex's skills.");
    // Capability flags surface...
    expect(out).toContain("codebaseAccess");
    // ...but NOT the body, and NOT the allowed-tools frontmatter (dec-10).
    expect(out).not.toContain("BODYMARKER_LIST");
    expect(out).not.toContain("allowed-tools");
  });

  it("get_skill returns the body + a file TOC (no inline contents); path yields a signed URL (ac-4)", async () => {
    tagAc(AC(4));
    const created = await call("update_skill", {
      verb: "create",
      memex: `${nsA}/main`,
      skill_md: reconstructSkillMd({
        name: "read-shape-skill",
        description: "Bundles assets. Use when: rendering the demo.",
        body: "BODYMARKER_READ\n\nThe skill body text.",
      }),
      files: [
        { path: "notes.md", purpose: "author notes", text: "SECRETCONTENT_TEXT" },
        {
          path: "logo.png",
          purpose: "brand mark",
          contentType: "image/png",
          dataBase64: PNG_BASE64,
        },
      ],
    });
    // The create confirmation leads with the canonical ref (no raw UUID).
    expect(created).toMatch(/ref: [a-z0-9-]+\/main\/skills\/skill-\d+/);

    const ref = `${nsA}/main/skills/${created.match(/skills\/(skill-\d+)/)![1]}`;

    // Default read: verbatim body + a TOC that names the files but NOT their bytes.
    const view = await call("get_skill", { ref });
    expect(view).toContain("BODYMARKER_READ");
    expect(view).toContain("notes.md");
    expect(view).toContain("logo.png");
    // The TOC never inlines a file's contents.
    expect(view).not.toContain("SECRETCONTENT_TEXT");

    // path → one file. The binary file hands back a short-lived signed read URL.
    const fileOut = await call("get_skill", { ref, path: "logo.png" });
    expect(fileOut.toLowerCase()).toContain("url");
    expect(fileOut).toMatch(/https?:\/\/|\/[^\s]+/); // a URL/path was minted
    expect(fileOut).toContain("image/png");

    // path → an inline text file hands its bytes back directly.
    const textOut = await call("get_skill", { ref, path: "notes.md" });
    expect(textOut).toContain("SECRETCONTENT_TEXT");
  });
});

describe("update_skill create → edit → delete round-trip + duplicate (ac-31, ac-36, ac-20)", () => {
  it("round-trips create → edit → delete, and rejects a duplicate name", async () => {
    tagAc(AC(20));
    tagAc(AC(31));
    tagAc(AC(36));

    // CREATE
    const created = await call("update_skill", {
      verb: "create",
      memex: `${nsA}/main`,
      skill_md: reconstructSkillMd({
        name: "roundtrip-skill",
        description: "Before edit. Use when: testing the round-trip.",
        body: "Old body.",
      }),
    });
    expect(created).toContain('Created skill "roundtrip-skill"');
    expect(created).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    const handle = created.match(/skills\/(skill-\d+)/)![1];
    const ref = `${nsA}/main/skills/${handle}`;

    // DUPLICATE (ac-36) — same name → user-visible rejection.
    await expect(
      call("update_skill", {
        verb: "create",
        memex: `${nsA}/main`,
        skill_md: reconstructSkillMd({
          name: "roundtrip-skill",
          description: "A clashing name. Use when: never.",
          body: "Body.",
        }),
      }),
    ).rejects.toThrow(/already exists/i);

    // EDIT (ac-31) — new SKILL.md re-reads verbatim.
    await call("update_skill", {
      verb: "edit",
      ref,
      skill_md: reconstructSkillMd({
        name: "roundtrip-skill",
        description: "After edit. Use when: testing the round-trip.",
        body: "New body.",
      }),
    });
    const edited = await call("get_skill", { ref });
    expect(edited).toContain("New body.");
    expect(edited).toContain("After edit. Use when: testing the round-trip.");

    // DELETE (ac-20) — soft-archive; the skill drops out of get + list.
    const deleted = await call("update_skill", { verb: "delete", ref });
    expect(deleted).toContain(`ref: ${ref}`);
    await expect(call("get_skill", { ref })).rejects.toThrow();
    const listAfter = await call("list_skills", { memex: `${nsA}/main` });
    expect(listAfter).not.toContain(handle);
  });
});

describe("cross-Memex tenancy — not-found (ac-11)", () => {
  it("list_skills / get_skill / update_skill against an inaccessible Memex are rejected", async () => {
    tagAc(AC(11));
    // memexB is private and the caller is not a member → the Memex resolver
    // rejects (std-7: not-found, not a permission leak) BEFORE any skill lookup.
    await expect(call("list_skills", { memex: `${nsB}/main` })).rejects.toBeInstanceOf(
      McpAuthError,
    );

    const foreignRef = `${nsB}/main/skills/skill-1`;
    await expect(call("get_skill", { ref: foreignRef })).rejects.toBeInstanceOf(
      McpAuthError,
    );
    await expect(
      call("update_skill", { verb: "delete", ref: foreignRef }),
    ).rejects.toBeInstanceOf(McpAuthError);
  });
});

describe("cross-Memex skills union — all_memexes (ac-62, ac-63, ac-64, ac-66)", () => {
  // A list_skills ctx whose accessible-Memex set is EXACTLY the given list — the
  // authorization seam the MCP surface binds to listMemberships. Deterministic
  // here so the grouped output is assertable; the single-Memex resolver is still
  // the real read-gated one (inherited from realCtx).
  function crossCtx(
    memexList: readonly { memexId: string; ref: string; memexName: string }[],
  ): ToolCtx {
    return {
      ...realCtx(specByName("list_skills")),
      listAccessibleMemexes: async () => memexList,
    } as unknown as ToolCtx;
  }
  const callAll = (
    memexList: readonly { memexId: string; ref: string; memexName: string }[],
  ): Promise<string> =>
    specByName("list_skills").handler({ all_memexes: true }, crossCtx(memexList));

  it("lists skills across every accessible Memex, grouped + fully-ref'd, and flags name collisions (ac-62, ac-63, ac-64)", async () => {
    tagAc(AC(62));
    tagAc(AC(63));
    tagAc(AC(64));

    // Seed: a solo skill in each Memex, plus one SAME-named skill in both.
    await call("update_skill", {
      verb: "create",
      memex: `${nsA}/main`,
      skill_md: reconstructSkillMd({
        name: "solo-in-a",
        description: "Only in A. Use when: proving per-Memex grouping.",
        body: "A body.",
      }),
    });
    await call("update_skill", {
      verb: "create",
      memex: `${nsC}/main`,
      skill_md: reconstructSkillMd({
        name: "solo-in-c",
        description: "Only in C. Use when: proving per-Memex grouping.",
        body: "C body.",
      }),
    });
    for (const ns of [nsA, nsC]) {
      await call("update_skill", {
        verb: "create",
        memex: `${ns}/main`,
        skill_md: reconstructSkillMd({
          name: "shared-name",
          description: "Lives in both. Use when: proving collision detection.",
          body: "Shared body.",
        }),
      });
    }

    const memexList = [
      { memexId: memexA, ref: `${nsA}/main`, memexName: "Main" },
      { memexId: memexC, ref: `${nsC}/main`, memexName: "Main" },
    ];
    const out = await callAll(memexList);

    // Grouped one section per Memex, each carrying that Memex's ref.
    expect(out).toContain(`(${nsA}/main)`);
    expect(out).toContain(`(${nsC}/main)`);
    // Each solo skill appears under its own Memex, with a full canonical ref.
    expect(out).toMatch(new RegExp(`solo-in-a[^\\n]*ref: ${nsA}/main/skills/skill-\\d+`));
    expect(out).toMatch(new RegExp(`solo-in-c[^\\n]*ref: ${nsC}/main/skills/skill-\\d+`));
    // The shared name surfaces in BOTH groups (two full refs) ...
    expect(out).toMatch(new RegExp(`shared-name[^\\n]*ref: ${nsA}/main/skills/skill-\\d+`));
    expect(out).toMatch(new RegExp(`shared-name[^\\n]*ref: ${nsC}/main/skills/skill-\\d+`));
    // ... and is flagged as a collision so the agent asks rather than guesses (ac-63).
    expect(out.toLowerCase()).toContain("collision");
    expect(out).toContain("shared-name");
    expect(out.toLowerCase()).toMatch(/ask the user|which memex/);
    // solo names never collide → not named in the banner region (before first "##").
    const banner = out.split("##")[0];
    expect(banner).not.toContain("solo-in-a");
  });

  it("skills-only: search_memex and list_docs carry no all_memexes, and all_memexes has no silent default (ac-66)", () => {
    tagAc(AC(66));
    // The cross-Memex union is a list_skills-only opt-in.
    const listSkillsSchema = specByName("list_skills").schema as Record<string, unknown>;
    expect(Object.keys(listSkillsSchema)).toContain("all_memexes");

    const byName = (n: string) => toolSpecs.find((t) => t.name === n);
    for (const other of ["search_memex", "list_docs"]) {
      const spec = byName(other);
      expect(spec, `${other} must be registered`).toBeTruthy();
      expect(Object.keys(spec!.schema)).not.toContain("all_memexes");
    }

    // No silent cross-Memex default: omitting all_memexes takes the single-Memex
    // path (std-5), never a quiet union. Proven by the field being optional +
    // the handler branching only on `=== true`.
    const zodField = listSkillsSchema.all_memexes as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(zodField.safeParse(undefined).success).toBe(true); // optional ⇒ defaults off
  });

  it("the @memex/shared manifest documents all_memexes for the coding agent (ac-65)", async () => {
    tagAc(AC(65));
    const { toolManifest } = await import("@memex/shared");
    const entry = toolManifest.find((e) => e.name === "list_skills");
    expect(entry).toBeTruthy();
    // args signature carries the new optional field (the b-67 parity test pins the
    // exact string against the live Zod shape; here we assert intent).
    expect(entry!.args).toContain("all_memexes");
    // summary instructs the cross-Memex discovery + the always-ask-on-collision rule.
    expect(entry!.summary).toContain("all_memexes");
    expect(entry!.summary.toLowerCase()).toMatch(/collide|collision|more than one memex/);
  });
});
