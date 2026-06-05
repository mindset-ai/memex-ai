// spec-161 (ac-15) — the LLM clause translator is OFF the interactive authoring path:
// no section/clause write service or tool imports it. Standards authored through
// add_section({clauses}) / add_clause / edit_clause carry their clauses verbatim; the
// translator is reachable only from the prose-ingestion path (the spec-150 migration
// today; a client drag-and-drop endpoint later). This is a source-scan guard so a
// future edit that quietly reintroduces auto-decomposition on the write path fails CI.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-161/acs/ac-${n}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), "utf8");

const TRANSLATOR = /clause-translator|translateSectionToClauses/;

describe("spec-161: clause translator is off the interactive authoring path (ac-15)", () => {
  it("the section and clause write services do not reference the translator", () => {
    tagAc(AC(15));
    for (const f of ["./clauses.ts", "./sections.ts"]) {
      expect(read(f)).not.toMatch(TRANSLATOR);
    }
  });

  it("the section/clause MCP tools do not reference the translator", () => {
    tagAc(AC(15));
    expect(read("../agent/tool-specs.ts")).not.toMatch(TRANSLATOR);
  });

  it("the translator stays available for the prose-ingestion path (the migration uses it)", () => {
    tagAc(AC(15));
    expect(read("./standards-migration.ts")).toMatch(TRANSLATOR);
  });
});
