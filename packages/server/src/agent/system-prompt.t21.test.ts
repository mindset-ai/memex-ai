// Unit coverage for t-21 prompt updates (Issues 4 + 7).
// Verifies the system / creation prompts and the spec-document skill carry
// the working definitions for Spec / Standard / Document and route rename
// requests to the update_doc tool.
//
// spec-230 update: the Issue-4 "minimal-default-scaffolding (Overview-only)"
// creation flow is SUPERSEDED. The in-app creation path now fleshes out a
// Spec input-drivenly — web ↔ MCP parity — so a substantial pasted document
// produces a rich, multi-section Spec while a vague idea stays light; the
// spec-5 Issue-4 over-scaffold guardrail is retained. The assertions below
// were flipped accordingly (tagged spec-230 ac-10).
//
// Note: the rename tool was consolidated to `update_doc({title})` when doc-5's
// t-1 work landed via merge.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks, buildCreationSystemBlocks } from "./system-prompt.js";
import { loadSkill } from "./skills.js";
import { getToolDefinitions, getCreationToolDefinitions } from "./tools.js";

const AC_REGRESSION_UPDATED =
  "mindset-prod/memex-building-itself/specs/spec-230/acs/ac-10";

describe("t-21 Issue 1 — system prompt routes rename to update_doc({title})", () => {
  // b-68 t-6 / ac-28: the rename guidance lived in `_base/mutation-protocol.md`,
  // which migrated to the `mutation-protocol` PromptBlockNode (surface:
  // `shared_nudge`) — it now reaches the agent via the nudge channel, not as a
  // React system block. The original assertion ("text MUST contain update_doc")
  // is inverted: the React system prompt MUST NOT contain it. The nudge-channel
  // coverage for the same rename guidance lives in scaffold-data.toNudge.test.ts.
  it("[updated by b-68 ac-28] React system prompt no longer carries rename guidance — moved to shared_nudge", () => {
    const blocks = buildSystemBlocks("", "specify");
    const text = blocks.map((b) => b.text).join("\n");
    // mutation-protocol is `shared_nudge` per dec-9 — `update_doc({title})`
    // rename guidance rides the nudge channel, not the React system prompt.
    expect(text).not.toContain("update_doc");
    expect(text).not.toMatch(/rename|retitle/i);
  });
});

// spec-230 (supersedes spec-5/dec-1): the t-21 Issue-4 "Overview-only with
// clean hand-off" behaviour is replaced by input-driven web ↔ MCP parity — a
// substantial pasted document fleshes out into a rich Spec; a vague idea stays
// light; the spec-5 Issue-4 over-scaffold guardrail is retained.
describe("t-21 Issue 4 (superseded by spec-230) — creation flow is input-driven, not Overview-only", () => {
  it("creation system prompt teaches input-driven fleshing-out, then a clean hand-off", () => {
    tagAc(AC_REGRESSION_UPDATED);
    const blocks = buildCreationSystemBlocks();
    const text = blocks.map((b) => b.text).join("\n");
    // No longer Overview-only / minimal-by-default by decree.
    expect(text).not.toMatch(/create only the Overview/i);
    expect(text).toMatch(/flesh out/i);
    expect(text).toMatch(/substantial (pasted )?document/i);
    expect(text).toMatch(/vague idea|keep it light/i);
    // Still hands off cleanly to the in-Spec chat (heads-up, not a question).
    expect(text).toMatch(/heads-up/i);
    expect(text).toMatch(/agent inside|in-spec|chat panel/i);
  });

  it("spec-document skill teaches input-driven authoring (content, not consent), keeping the no-stub guardrail", () => {
    tagAc(AC_REGRESSION_UPDATED);
    const skill = loadSkill("spec-document");
    expect(skill).not.toMatch(/do not auto-add body sections during creation/i);
    expect(skill).not.toMatch(/don't add the spine without consent/i);
    expect(skill).toMatch(/content, not consent/i);
    expect(skill).toMatch(/never (add )?(empty )?(or premature )?stub/i);
  });
});

// SKIP: doc-24 — Standard / Document doc types no longer exposed on MCP/agent surface; restore alongside the tools.
describe.skip("t-21 Issue 7 — agent has knowledge of Spec / Standard / Document", () => {
  it("system prompt defines all three document types", () => {
    const blocks = buildSystemBlocks("", "specify");
    const text = blocks.map((b) => b.text).join("\n");
    expect(text).toMatch(/\bSpec\b/);
    expect(text).toMatch(/\bStandard\b/);
    expect(text).toMatch(/\bDocument\b/);
    // Standard definition must mention rules, drift, and provenance (canonical spec-N:dec-M form)
    expect(text).toMatch(/rules?, conventions/i);
    expect(text).toMatch(/drift/i);
    expect(text).toMatch(/per spec-N:dec-M/);
  });

  it("spec-document skill defines all three document types", () => {
    const skill = loadSkill("spec-document");
    expect(skill).toMatch(/Spec.*?the substrate for planned software work|Spec.*?the why/i);
    expect(skill).toMatch(/Standard.*?living rule document/i);
    expect(skill).toMatch(/Document.*?generic knowledge artifact/i);
  });

  // SKIP: doc-24 — flag_drift / propose_standard_change / search_standards hidden; restore alongside the tools.
  it.skip("agent server tools include the doc-14 standards surface (list_docs/get_doc/create_doc + named verbs)", () => {
    // doc-14: list_standards / get_standard / create_standard folded into list_docs / get_doc / create_doc
    // with docType: 'standard'. Named verbs `flag_drift`, `propose_standard_change`, `search_standards`
    // survive (each carries distinct prompt-engineering value).
    const names = getToolDefinitions().map((t) => t.name);
    expect(names).toContain("list_docs");
    expect(names).toContain("get_doc");
    expect(names).toContain("create_doc");
    expect(names).toContain("flag_drift");
    expect(names).toContain("propose_standard_change");
    expect(names).toContain("search_standards");
    // The cut names must not be present.
    expect(names).not.toContain("list_standards");
    expect(names).not.toContain("get_standard");
    expect(names).not.toContain("create_standard");
  });

  it("agent server tools include update_doc (consolidated from update_doc_title / update_doc_status)", () => {
    const names = getToolDefinitions().map((t) => t.name);
    expect(names).toContain("update_doc");
    // doc-14: legacy update_doc_title and update_doc_status folded into update_doc({title?, status?}).
    expect(names).not.toContain("rename_doc");
    expect(names).not.toContain("update_doc_title");
    expect(names).not.toContain("update_doc_status");
  });

  it("getCreationToolDefinitions exposes the spec-authoring surface; legacy rename verbs and read-list tools stay out", () => {
    const names = getCreationToolDefinitions().map((t) => t.name);
    // spec-230: the creation surface reaches the full spec-authoring set
    // (sections, decisions, ACs). update_doc is now legitimately present
    // (manifest group 'planning'); only the LEGACY rename verbs and the
    // doc/standard LIST tools stay out.
    expect(names).toContain("create_doc");
    expect(names).toContain("add_section");
    expect(names).not.toContain("rename_doc");
    expect(names).not.toContain("update_doc_title");
    expect(names).not.toContain("list_standards");
    expect(names).not.toContain("list_docs");
  });
});
