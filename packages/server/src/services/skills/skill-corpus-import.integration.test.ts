import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { memexes } from "../../db/schema.js";
import { makeTestMemex } from "../test-helpers.js";
import { createSkill, getSkill, getSkillFile, listSkills } from "./skills-service.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";

// spec-300 t-8 — corpus import verification. Proves a real, MULTI-FILE skill
// package imports and round-trips through the service (the code path the coding
// agent's update_skill{create} + get_skill wrap): the SKILL.md comes back
// byte-faithful and every auxiliary file appears in the table-of-contents and is
// individually retrievable. The fixture is built IN-REPO (std-22: no external
// absolute paths) and is shaped like an `sdk3-embed-starter` package — a SKILL.md
// plus `templates/*` auxiliary files. A single-file skill (no auxiliaries) is
// imported alongside, so both corpus shapes are covered.
//
// NOTE: seeding the live blueprint corpus into a PROD Memex is a separate
// OPERATIONAL step (a coding agent driving update_skill over MCP), not this test.
// The MCP tool surface itself is exercised in src/mcp/skills-tools.integration.test.ts.

const ac = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

// ── The in-repo fixture: an sdk3-embed-starter-shaped multi-file package ──────

const INDEX_HTML = `<!doctype html>
<html>
  <head><title>Embed starter</title></head>
  <body><div id="root"></div></body>
</html>
`;

const APP_JSX = `export function App() {
  return <div>Mindset SDK3 embed starter</div>;
}
`;

const STARTER_SKILL_MD = reconstructSkillMd({
  name: "sdk3-embed-starter",
  description:
    "Scaffolds a webpage that embeds a Mindset SDK3 agent. Use when: a dev wants a working embed starter.",
  body: [
    "# SDK3 embed starter",
    "",
    "Copy `templates/index.html` and `templates/app.jsx` into a new project,",
    "then wire the agent per the instructions below.",
  ].join("\n"),
});

const SINGLE_FILE_SKILL_MD = reconstructSkillMd({
  name: "solo-procedure",
  description: "A one-file skill with no bundled assets. Use when: nothing extra is needed.",
  body: "# Solo procedure\n\nA self-contained set of steps, no auxiliary files.",
});

let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("skl-corpus");
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, [memexId])).catch(() => {});
});

describe("corpus import — a multi-file skill package round-trips through the service", () => {
  it("imports SKILL.md + templates/* and returns them byte-faithfully + in the TOC", async () => {
    tagAc(ac(20)); // coding-agent import path (service that update_skill wraps)
    tagAc(ac(4)); // list body + TOC + fetch each auxiliary file on demand
    tagAc(ac(13)); // a skill carries auxiliary files as part of one package

    // Import the package exactly as a coding agent's update_skill{create} would:
    // one SKILL.md primary + two text auxiliary files under templates/.
    const created = await createSkill(memexId, {
      skillMd: STARTER_SKILL_MD,
      files: [
        { path: "templates/index.html", purpose: "the page shell", text: INDEX_HTML },
        { path: "templates/app.jsx", purpose: "the React entrypoint", text: APP_JSX },
      ],
    });
    expect(created.name).toBe("sdk3-embed-starter");

    // The imported skill is listable (name + description metadata).
    const list = await listSkills(memexId);
    expect(list.some((s) => s.handle === created.handle)).toBe(true);

    const fetched = await getSkill(memexId, created.handle);

    // 1. The SKILL.md round-trips BYTE-FAITHFULLY (the reconstruct read path is the
    //    exact inverse of the parse write path).
    expect(fetched.skillMd).toBe(STARTER_SKILL_MD);

    // 2. EVERY auxiliary file is present in the TOC (path/purpose/type/size only —
    //    never inline contents).
    expect(fetched.files.map((f) => f.path)).toEqual([
      "templates/app.jsx",
      "templates/index.html",
    ]);
    for (const entry of fetched.files) {
      expect(Object.keys(entry).sort()).toEqual(
        ["contentType", "path", "purpose", "size"].sort(),
      );
      expect(entry.size).toBeGreaterThan(0);
    }
    // The body/TOC never inlines a file's bytes.
    expect(fetched.skillMd).not.toContain("<!doctype html>");

    // 3. Each auxiliary file is individually retrievable on demand, byte-for-byte.
    const indexAccess = await getSkillFile(memexId, created.handle, "templates/index.html");
    expect(indexAccess.kind).toBe("inline");
    if (indexAccess.kind === "inline") {
      expect(indexAccess.text).toBe(INDEX_HTML);
    }
    const appAccess = await getSkillFile(memexId, created.handle, "templates/app.jsx");
    expect(appAccess.kind).toBe("inline");
    if (appAccess.kind === "inline") {
      expect(appAccess.text).toBe(APP_JSX);
    }
  });

  it("imports a single-file skill (no auxiliary files) and round-trips it byte-faithfully", async () => {
    tagAc(ac(20));

    const created = await createSkill(memexId, { skillMd: SINGLE_FILE_SKILL_MD });
    const fetched = await getSkill(memexId, created.handle);

    expect(fetched.skillMd).toBe(SINGLE_FILE_SKILL_MD);
    expect(fetched.files).toHaveLength(0);
  });
});
