// spec-126 dec-3 — the capability-scoped review tool allowance.
//
// getToolDefinitions({reviewer:true}) drops the blocked mutations (definition
// filter); isToolAllowedForReviewer is the fail-closed predicate the execution
// gate uses. Pure assertions over the tool contract — no DB, no LLM.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { getToolDefinitions, isToolAllowedForReviewer, isReadOnlyTool } from "./tools.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-126/acs/ac-${n}`;

// The mutations a reviewer must never be able to invoke (dec-3).
const BLOCKED = [
  "resolve_decision",
  "create_task",
  "update_section",
  "create_ac",
  "update_doc", // phase moves / publish ride update_doc + publish_spec
  "publish_spec",
];
// The reviewer's permitted surface (dec-3): read/search + comment + raise Issue.
const ALLOWED = ["get_doc", "search_memex", "add_comment", "update_comment", "register_issue"];

const names = (tools: ReturnType<typeof getToolDefinitions>) =>
  new Set(tools.map((t) => (t as { name: string }).name));

describe("spec-126 reviewer tool allowance", () => {
  it("a reviewer's tool list excludes every blocked mutation (ac-5)", () => {
    tagAc(AC(5));
    const reviewerTools = names(getToolDefinitions({ reviewer: true }));
    for (const blocked of BLOCKED) {
      expect(reviewerTools.has(blocked), `reviewer must not be offered ${blocked}`).toBe(false);
    }
  });

  it("a reviewer keeps the allowed read/search/comment tools, incl. register_issue (ac-5, ac-12)", () => {
    tagAc(AC(5));
    tagAc(AC(12)); // raise an Issue is permitted; other issue verbs are not
    const reviewerTools = names(getToolDefinitions({ reviewer: true }));
    for (const allowed of ALLOWED) {
      expect(reviewerTools.has(allowed), `reviewer should keep ${allowed}`).toBe(true);
    }
    // The other issue verbs stay blocked for reviewers (forward-driving).
    for (const blockedIssueVerb of ["update_issue", "resolve_issue", "convert_issue_to_task"]) {
      expect(reviewerTools.has(blockedIssueVerb), `${blockedIssueVerb} blocked`).toBe(false);
    }
  });

  it("the editor toolset is unchanged — full set, blocked mutations present (ac-2)", () => {
    tagAc(AC(2));
    const editorTools = getToolDefinitions(); // no opts === editor
    const editorReviewerFalse = getToolDefinitions({ reviewer: false });
    // editor === reviewer:false, and strictly larger than the reviewer set.
    expect(editorTools.length).toBe(editorReviewerFalse.length);
    const editorNames = names(editorTools);
    for (const blocked of BLOCKED) {
      expect(editorNames.has(blocked), `editor keeps ${blocked}`).toBe(true);
    }
    expect(editorTools.length).toBeGreaterThan(getToolDefinitions({ reviewer: true }).length);
  });

  it("isToolAllowedForReviewer is fail-closed: mutations blocked, reads/comments allowed (ac-5)", () => {
    tagAc(AC(5));
    for (const blocked of BLOCKED) {
      expect(isToolAllowedForReviewer(blocked), `${blocked} blocked`).toBe(false);
    }
    for (const allowed of ALLOWED) {
      expect(isToolAllowedForReviewer(allowed), `${allowed} allowed`).toBe(true);
    }
    // An unknown tool name fails closed.
    expect(isToolAllowedForReviewer("totally_new_mutation")).toBe(false);
  });

  // spec-126 ac-15 — the write-gate predicate. isReadOnlyTool decides what a
  // NON-writer may run: only readOnlyHint reads/search. CRUCIALLY, the reviewer
  // write allow-list (add_comment/update_comment/register_issue) is NOT read-only
  // — so a non-writer who defaults to reviewer is blocked from them, while a
  // writing reviewer (gated separately by isToolAllowedForReviewer) is not.
  it("isReadOnlyTool: reads pass, every mutation (incl. the reviewer allow-list) fails closed (ac-15)", () => {
    tagAc(AC(15));
    for (const readOnly of ["get_doc", "search_memex"]) {
      expect(isReadOnlyTool(readOnly), `${readOnly} is read-only`).toBe(true);
    }
    // All mutations are NOT read-only — a non-writer is blocked from them...
    for (const mutation of BLOCKED) {
      expect(isReadOnlyTool(mutation), `${mutation} is a mutation`).toBe(false);
    }
    // ...including the three reviewer-allow-listed writes (the ac-16 distinction:
    // allow-list applies on TOP of write capability, never instead of it).
    for (const write of ["add_comment", "update_comment", "register_issue"]) {
      expect(isReadOnlyTool(write), `${write} is a mutation`).toBe(false);
    }
    // Unknown tool names fail closed (treated as a mutation).
    expect(isReadOnlyTool("totally_new_mutation")).toBe(false);
  });
});
