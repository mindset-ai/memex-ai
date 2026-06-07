// Unit coverage for t-21 prompt updates (Issues 4 + 7).
// Verifies the system / creation prompts and the spec-document skill carry
// the working definitions for Spec / Standard / Document, route rename
// requests to the update_doc_title tool, and teach the minimal-default-
// scaffolding (Overview-only) creation flow.
//
// Note: the rename tool was consolidated to `update_doc_title` (was
// `rename_doc` on main pre-merge) when doc-5's t-1 work landed via merge.
// The creation-flow "ask after create" pattern was inverted to "hand off
// cleanly" because the New Spec modal closes once create_doc returns
// and the user has no input affordance for a follow-up question.

import { describe, it, expect } from "vitest";
import { buildSystemBlocks, buildCreationSystemBlocks } from "./system-prompt.js";
import { loadSkill } from "./skills.js";
import { getToolDefinitions, getCreationToolDefinitions } from "./tools.js";

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

describe("t-21 Issue 4 — creation flow is Overview-only with clean hand-off", () => {
  it("creation system prompt teaches 'Overview only, then close out'", () => {
    const blocks = buildCreationSystemBlocks();
    const text = blocks.map((b) => b.text).join("\n");
    expect(text).toMatch(/Minimal-by-Default|minimal-by-default|Overview only|Overview-only/i);
    // The prompt must tell the agent the modal closes after create_doc and
    // any follow-up belongs in the in-Spec chat panel — NOT a question
    // here.
    expect(text).toMatch(/closes|hand off|cannot reply|can't reply|heads-up/i);
    expect(text).toMatch(/agent inside|in-spec|chat panel/i);
  });

  it("spec-document skill teaches Overview-only-by-default", () => {
    const skill = loadSkill("spec-document");
    expect(skill).toMatch(/do not auto-add body sections during creation|Don't pad with stubs; don't add the spine without consent|Overview-only/i);
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

  it("getCreationToolDefinitions still exposes only create_doc + add_section + UI tools", () => {
    const names = getCreationToolDefinitions().map((t) => t.name);
    // Creation phase intentionally limits the surface; rename / standard tools
    // are document-phase only.
    expect(names).toContain("create_doc");
    expect(names).toContain("add_section");
    expect(names).not.toContain("rename_doc");
    expect(names).not.toContain("update_doc_title");
    expect(names).not.toContain("update_doc");
    expect(names).not.toContain("list_standards");
    expect(names).not.toContain("list_docs");
  });
});
