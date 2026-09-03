// spec-300 t-7 (dec-7, ac-29) — the active Memex's Skill catalogue is APPENDED to
// an early tool response (the shared `list_docs` orient, the memex-scoped analog of
// list_memexes' topic-index append), NOT the MCP instructions block. Because
// list_docs is ONE shared tool spec, the SAME catalogue reaches both the in-app
// agent and a connected coding agent (ac-29).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { toolSpecs } from "./tool-specs.js";
import type { ToolCtx, ToolSpec } from "./handlers/tool-contract.js";
import { createSkill } from "../services/skills/skills-service.js";
import { formatSkillCatalogueAppendix } from "../services/skills/skill-catalogue.js";
import { reconstructSkillMd } from "../services/skills/reconstruct-skill-md.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

const SKILL_MD = reconstructSkillMd({
  name: "pdf-extractor",
  description: "Extracts text from PDFs. Use when: the user uploads a PDF file.",
  body: "# PDF extractor\n\n1. Open the PDF.\n2. Extract the text.",
});

const listDocsSpec = (): ToolSpec => {
  const s = toolSpecs.find((t) => t.name === "list_docs");
  if (!s) throw new Error("list_docs tool spec not found");
  return s;
};

/** Minimal in-app-style ctx: the route already resolved the bound memex, so
 *  resolveMemex just returns it (agent/tools.ts buildAgentCtx does the same). */
function ctxFor(memexId: string): ToolCtx {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    channel: "in_app_agent",
    verbose: false,
    resolveMemex: async () => memexId,
    resolveMemexFromEntity: async () => memexId,
    resolveRef: async () => {
      throw new Error("resolveRef unused by list_docs");
    },
    workspaceUrl: async () => "",
  } as unknown as ToolCtx;
}

let memexWithSkill: string;
let memexNoSkill: string;

beforeAll(async () => {
  memexWithSkill = await makeTestMemex("skl-cat-a");
  memexNoSkill = await makeTestMemex("skl-cat-b");
  await createSkill(memexWithSkill, { skillMd: SKILL_MD });
});

afterAll(async () => {
  await db
    .delete(memexes)
    .where(inArray(memexes.id, [memexWithSkill, memexNoSkill]))
    .catch(() => {});
});

describe("skill catalogue on an early tool response (ac-29)", () => {
  it("appends the active Memex's skill catalogue (name + description + capability flags) to list_docs", async () => {
    tagAc(AC(29));
    const spec = listDocsSpec();
    const out = await spec.handler({}, ctxFor(memexWithSkill));

    // The catalogue rides the early orient response with the list_skills metadata:
    // name, description, capability flags, and ref.
    expect(out).toContain("Skills available in this Memex (1)");
    expect(out).toContain("pdf-extractor");
    expect(out).toContain("Extracts text from PDFs. Use when: the user uploads a PDF file.");
    expect(out).toContain("capabilities: none");
    expect(out).toMatch(/skills\/skill-\d+/);
  });

  it("appends the SAME catalogue single-sourced from formatSkillCatalogueAppendix (drives both surfaces)", async () => {
    tagAc(AC(29));
    const appendix = await formatSkillCatalogueAppendix(memexWithSkill);
    expect(appendix).not.toBe("");

    // The shared list_docs handler ends with exactly the shared appendix — the one
    // catalogue both the in-app agent and the coding agent see (list_docs is a
    // single shared tool spec registered on both surfaces).
    const out = await listDocsSpec().handler({}, ctxFor(memexWithSkill));
    expect(out.endsWith(appendix)).toBe(true);
  });

  it("appends nothing when the Memex has no skills (block only appears when skills exist)", async () => {
    tagAc(AC(29));
    const appendix = await formatSkillCatalogueAppendix(memexNoSkill);
    expect(appendix).toBe("");

    const out = await listDocsSpec().handler({}, ctxFor(memexNoSkill));
    expect(out).not.toContain("Skills available in this Memex");
  });
});
