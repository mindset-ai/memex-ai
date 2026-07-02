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
  getSkillFile,
  listSkills,
  editSkill,
  archiveSkill,
} from "./skills-service.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";

// spec-300 t-10 — DB integration for the Skills service: the single server code
// path the MCP tools + React UI wrap. Wires t-1 (docType='skill' rows +
// skill_files), t-3 (parse/validate/reconstruct), t-2 (storage) together.

const ac = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

// A canonical SKILL.md built THROUGH t-3's reconstruct, so a create→get round-trip
// is byte-exact (the reconstruct read path is the inverse of the parse write path).
const CANONICAL_SKILL_MD = reconstructSkillMd({
  name: "pdf-extractor",
  description: "Extracts text from PDFs. Use when: the user uploads a PDF file.",
  body: "# PDF extractor\n\nSteps to extract text from a PDF document.",
});

let memexA: string;
let memexB: string;

beforeAll(async () => {
  memexA = await makeTestMemex("skl-a");
  memexB = await makeTestMemex("skl-b");
});

afterAll(async () => {
  // Cascade through memexes → documents → skill_files.
  await db.delete(memexes).where(inArray(memexes.id, [memexA, memexB])).catch(() => {});
});

describe("createSkill + getSkill", () => {
  it("round-trips the SKILL.md byte-faithfully through create → get", async () => {
    tagAc(ac(1));
    tagAc(ac(34));
    tagAc(ac(22));

    const created = await createSkill(memexA, { skillMd: CANONICAL_SKILL_MD });
    expect(created.handle).toMatch(/^skill-\d+$/);
    expect(created.name).toBe("pdf-extractor");
    expect(created.ref.endsWith(`/skills/${created.handle}`)).toBe(true);

    const fetched = await getSkill(memexA, created.handle);
    // Byte-faithful: the reconstructed SKILL.md equals the canonical source bytes.
    expect(fetched.skillMd).toBe(CANONICAL_SKILL_MD);
    expect(fetched.name).toBe("pdf-extractor");
    expect(fetched.description).toBe(
      "Extracts text from PDFs. Use when: the user uploads a PDF file.",
    );
  });

  it("persists Memex-native capability flags authored at create time (dec-20)", async () => {
    const md = reconstructSkillMd({
      name: "code-helper",
      description: "Edits code. Use when: the user asks for a refactor.",
      body: "Body.",
    });
    const created = await createSkill(memexA, {
      skillMd: md,
      capabilities: { codebaseAccess: true, codeEditing: true },
    });
    expect(created.capabilities).toEqual({
      codebaseAccess: true,
      codeEditing: true,
      externalTools: false,
    });
    const fetched = await getSkill(memexA, created.handle);
    expect(fetched.capabilities).toEqual({
      codebaseAccess: true,
      codeEditing: true,
      externalTools: false,
    });
  });

  it("returns the body + a file TOC, never file contents inline", async () => {
    tagAc(ac(15));

    const created = await createSkill(memexA, {
      skillMd: reconstructSkillMd({
        name: "toc-skill",
        description: "Has files. Use when: you need bundled assets.",
        body: "# Body\n\nText.",
      }),
      files: [
        { path: "templates/index.html", purpose: "the page shell", text: "<html></html>" },
      ],
    });

    const fetched = await getSkill(memexA, created.handle);
    // Body is present in the reconstructed SKILL.md...
    expect(fetched.skillMd).toContain("# Body");
    // ...and the TOC entry carries path/purpose/type/size but NO contents.
    expect(fetched.files).toHaveLength(1);
    const entry = fetched.files[0]!;
    expect(entry.path).toBe("templates/index.html");
    expect(entry.purpose).toBe("the page shell");
    expect(entry.size).toBeGreaterThan(0);
    // The TOC entry shape is exactly {path,purpose,contentType,size} — no text/blob.
    expect(Object.keys(entry).sort()).toEqual(
      ["contentType", "path", "purpose", "size"].sort(),
    );
    expect((entry as unknown as Record<string, unknown>).text).toBeUndefined();
    expect((entry as unknown as Record<string, unknown>).blobUri).toBeUndefined();
  });
});

describe("auxiliary files — text (inline) + binary (bucket)", () => {
  it("persists both storage kinds in the manifest and returns them in the TOC", async () => {
    tagAc(ac(13));

    const created = await createSkill(memexA, {
      skillMd: reconstructSkillMd({
        name: "asset-skill",
        description: "Bundles assets. Use when: rendering the demo.",
        body: "Body.",
      }),
      files: [
        { path: "notes.md", purpose: "author notes", text: "# Notes\nhello" },
        {
          path: "logo.png",
          purpose: "brand mark",
          contentType: "image/png",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      ],
    });

    const fetched = await getSkill(memexA, created.handle);
    // TOC is alphabetical by path: logo.png then notes.md.
    expect(fetched.files.map((f) => f.path)).toEqual(["logo.png", "notes.md"]);

    // The inline text file hands back its bytes directly (no blob to sign).
    const noteAccess = await getSkillFile(memexA, created.handle, "notes.md");
    expect(noteAccess.kind).toBe("inline");
    if (noteAccess.kind === "inline") {
      expect(noteAccess.text).toBe("# Notes\nhello");
    }

    // The binary file went to the blob store and hands back a signed read URL.
    const logoAccess = await getSkillFile(memexA, created.handle, "logo.png");
    expect(logoAccess.kind).toBe("bucket");
    if (logoAccess.kind === "bucket") {
      expect(typeof logoAccess.url).toBe("string");
      expect(logoAccess.url.length).toBeGreaterThan(0);
      expect(logoAccess.contentType).toBe("image/png");
    }
  });
});

describe("tenancy isolation (std-7 / std-4)", () => {
  it("a skill in memex A is not listed in, or gettable from, memex B", async () => {
    tagAc(ac(6));
    tagAc(ac(11));

    const created = await createSkill(memexA, {
      skillMd: reconstructSkillMd({
        name: "private-a",
        description: "Only in A. Use when: never from B.",
        body: "Body.",
      }),
    });

    // listSkills(B) never returns A's skill.
    const listB = await listSkills(memexB);
    expect(listB.some((s) => s.handle === created.handle)).toBe(false);

    // getSkill from B → NotFound (404, not 403 — std-7).
    await expect(getSkill(memexB, created.handle)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listSkills returns active skills alphabetical by name, metadata only", async () => {
    const list = await listSkills(memexA);
    const names = list.map((s) => s.name);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // Metadata only — no body / skillMd / allowed-tools leaks into the list shape.
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(
        ["capabilities", "description", "handle", "lastUpdatedAt", "name", "ref"].sort(),
      );
    }
  });
});

describe("editSkill + archiveSkill", () => {
  it("edits the SKILL.md (name/description/body) and re-reads verbatim", async () => {
    const created = await createSkill(memexA, {
      skillMd: reconstructSkillMd({
        name: "editable",
        description: "Before edit. Use when: testing edit.",
        body: "Old body.",
      }),
    });

    const newMd = reconstructSkillMd({
      name: "editable",
      description: "After edit. Use when: testing edit.",
      body: "New body.",
    });
    await editSkill(memexA, created.handle, { skillMd: newMd });

    const fetched = await getSkill(memexA, created.handle);
    expect(fetched.skillMd).toBe(newMd);
    expect(fetched.description).toBe("After edit. Use when: testing edit.");
  });

  it("soft-deletes via archive so the skill drops out of list + get", async () => {
    const created = await createSkill(memexA, {
      skillMd: reconstructSkillMd({
        name: "to-archive",
        description: "Will be archived. Use when: never after.",
        body: "Body.",
      }),
    });

    await archiveSkill(memexA, created.handle);

    const list = await listSkills(memexA);
    expect(list.some((s) => s.handle === created.handle)).toBe(false);
    await expect(getSkill(memexA, created.handle)).rejects.toBeInstanceOf(NotFoundError);
  });
});
