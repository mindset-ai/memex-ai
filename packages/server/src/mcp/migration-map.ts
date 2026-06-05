// Doc-14 / dec-5 (+ b-36 T-6): hard-cut tool migration map.
//
// The doc-14 refactor consolidated 62 MCP tools down to ~32. Removed names
// hard-cut with a structured error pointing at the replacement (no silent
// breakage, no permanent aliases). b-36 then collapsed each tool's identity
// arg surface to a single canonical `ref` — this file still tracks REMOVED
// tool names, but the entries' notes now describe the ref-based call shape.
// This file is the single source of truth — it powers:
//
//   1. Runtime: the MCP request handler in `app.ts` checks here when an unknown tool
//      name comes in and surfaces the migration error to the client.
//   2. Tests: `migration-errors.integration.test.ts` (t-9) iterates over every entry
//      and asserts the structured error fires.
//   3. Parity gate: `tools-coverage.regression.test.ts` (t-10) asserts every old
//      name is absent from both the MCP and the React UI agent surfaces.
//
// Adding/removing entries: bump both the runtime check and the parity gate. Don't
// duplicate the list anywhere else.

export interface MigrationEntry {
  /** The replacement tool the agent should call instead. */
  replacement: string;
  /** Human/LLM-readable migration note describing how to remediate. */
  note: string;
}

/**
 * Old tool name → migration entry. Generated mechanically from the doc-14 cut/keep/
 * rename mapping in the t-2 PR description.
 */
export const MIGRATION_MAP: Record<string, MigrationEntry> = {
  // ── doc CRUD: type-specific listers + helpers fold into the generic doc tools ──
  list_standards: {
    replacement: "list_docs",
    note: "Use `list_docs({ memex, docType: 'standard' })` instead.",
  },
  get_standard: {
    replacement: "get_doc",
    note: "Use `get_doc({ ref })` with a canonical standard ref (e.g. `mindset/main/standards/std-5`).",
  },
  get_doc_url: {
    replacement: "get_doc",
    note: "`get_doc` already returns the public URL in its response.",
  },
  create_standard: {
    replacement: "create_doc",
    note: "Use `create_doc({ title, sections, docType: 'standard', description? })` instead.",
  },
  update_doc_status: {
    replacement: "update_doc",
    note: "Use `update_doc({ ref, status })` with a canonical doc ref.",
  },
  update_doc_title: {
    replacement: "update_doc",
    note: "Use `update_doc({ ref, title })` with a canonical doc ref.",
  },
  update_standard: {
    replacement: "update_section",
    note: "Use `update_section({ ref })` to apply prose edits, or `propose_standard_change` to record a reviewer-bound revision.",
  },

  // ── decisions ──
  add_draft_decision: {
    replacement: "create_decision",
    note: "Use `create_decision({ ref, title, context })` with the parent doc's canonical ref.",
  },
  propose_decision: {
    replacement: "create_decision",
    note: "Use `create_decision({ ref, title, context, status: 'candidate', options })` with the parent doc's canonical ref.",
  },
  reopen_decision: {
    replacement: "update_decision",
    note: "Use `update_decision({ ref, status: 'open' })` with the decision's canonical ref.",
  },
  get_decision_impact: {
    replacement: "get_doc",
    note: "Use `get_doc({ ref })` — the doc state already lists each decision and the tasks blocked by it.",
  },
  affected_by_decision: {
    replacement: "search_memex",
    note: "Use `search_memex({ memex, query: 'dec-N', kind: 'standard' })` to find standards that cite a decision.",
  },

  // ── search_standards → search_memex (b-34) ──
  search_standards: {
    replacement: "search_memex",
    note: "Use `search_memex({ memex, query, kind: 'standard' })` instead. `search_memex` covers Briefs, Standards, free-form documents, and Decisions in one tool; pass `kind` to restrict scope.",
  },

  // ── tasks ──
  add_draft_task: {
    replacement: "create_task",
    note: "Use `create_task({ ref, title, description, acceptanceCriteria, sectionRef })` with the parent doc's canonical ref.",
  },
  update_task_status: {
    replacement: "update_task",
    note: "Use `update_task({ ref, status: 'not_started' | 'in_progress' | 'complete' })` with the task's canonical ref.",
  },
  add_blocker: {
    replacement: "update_task",
    note: "Use `update_task({ ref, addBlockerRef: '<canonical decision or task ref>' })` instead.",
  },
  remove_blocker: {
    replacement: "update_task",
    note: "Use `update_task({ ref, removeBlockerRef: '<canonical decision or task ref>' })` instead.",
  },
  promote_task: {
    replacement: "create_doc",
    note: "Use `create_doc({ docType: 'spec', title, purpose, promoteFromTaskRef: '<canonical task ref>' })` instead.",
  },
  get_ready_tasks: {
    replacement: "get_doc",
    note: "Use `get_doc({ ref })` — the doc state lists every task with its blockers (an empty blocker list = ready).",
  },
  get_dependents: {
    replacement: "get_doc",
    note: "Use `get_doc({ ref })` on the parent Spec — the formatted output lists dependent execution plans.",
  },

  // ── comments ──
  list_doc_comments: {
    replacement: "list_comments",
    note: "Use `list_comments({ ref })` with a canonical doc ref.",
  },
  list_task_notes: {
    replacement: "list_comments",
    note: "Use `list_comments({ ref, mode: 'task_notes' })` with a canonical task ref.",
  },
  list_open_questions: {
    replacement: "list_comments",
    note: "Use `list_comments({ ref, types: ['question'] })` with a canonical doc ref.",
  },
  review_doc_comments: {
    replacement: "list_comments",
    note: "Use `list_comments({ ref, mode: 'review' })`. Defaults to excluding agent `progress` notes.",
  },
  resolve_comment: {
    replacement: "update_comment",
    note: "Use `update_comment({ ref, status: 'resolved', resolution })` with the comment's canonical ref.",
  },

  // ── spec lifecycle ──
  assess_phase_transition: {
    replacement: "assess_spec",
    note: "Use `assess_spec({ ref, mode: 'phase', target: 'plan' | 'build' | 'verify' | 'done' })` instead.",
  },
  assess_narrative_freshness: {
    replacement: "assess_spec",
    note: "Use `assess_spec({ ref, mode: 'narrative' })` instead.",
  },
  assess_comments_status: {
    replacement: "assess_spec",
    note: "Use `assess_spec({ ref, mode: 'comments' })` instead.",
  },
  mark_narrative_consolidated: {
    replacement: "assess_spec",
    note: "Use `assess_spec({ ref, mode: 'consolidate' })` instead.",
  },
  // b-105: legacy `assess_brief` tool name from the pre-Spec era. The new
  // canonical is `assess_spec`.
  assess_brief: {
    replacement: "assess_spec",
    note: "Use `assess_spec({ ref, mode, target? })` — same signature, renamed in b-105.",
  },

  // ── execution plans ──
  submit_execution_plan: {
    replacement: "create_doc",
    note: "Use `create_doc({ docType: 'execution_plan', linkedTaskRef, title?, sections?, readinessAssessment? })` instead.",
  },
  get_execution_plan: {
    replacement: "list_docs",
    note: "Use `list_docs({ docType: 'execution_plan' })`, or `get_doc({ ref })` on the plan ref directly.",
  },

  // ── codebase intelligence ──
  get_repo_overview: {
    replacement: "get_repo",
    note: "Use `get_repo({ repoRef })` — the response carries counts, tech stack, domains, and structural conventions.",
  },
  set_repo_domain_aliases: {
    replacement: "update_repo",
    note: "Use `update_repo({ repoRef, domainAliases: { domainName, aliases, description? } })` instead.",
  },
  find_symbol: {
    replacement: "list_symbols",
    note: "Use `list_symbols({ repoRef, query, kind?, exportedOnly?, domain? })` instead.",
  },
  get_endpoints: {
    replacement: "list_symbols",
    note: "Use `list_symbols({ repoRef, kind: 'endpoint', domain?, framework? })` instead.",
  },
  get_dependencies: {
    replacement: "get_symbol",
    note: "Use `get_symbol({ repoRef, fileId | path, include: ['dependencies'], direction? })` instead.",
  },
  get_impact: {
    replacement: "get_symbol",
    note: "Use `get_symbol({ repoRef, fileId | path, include: ['impact'], depth? })` instead.",
  },
  get_call_graph: {
    replacement: "get_symbol",
    note: "Use `get_symbol({ repoRef, symbolId, include: ['calls'], direction?, includeNoise?, limit? })` instead.",
  },
  get_file_content: {
    replacement: "get_file",
    note: "Use `get_file({ repoRef, fileId | path })` instead.",
  },
};

/** All removed tool names. Useful for parity-test assertions. */
export const REMOVED_TOOL_NAMES: readonly string[] = Object.freeze(
  Object.keys(MIGRATION_MAP).slice(),
);

/** Build the structured migration error message for an old tool name. */
export function migrationErrorMessage(oldName: string): string | null {
  const entry = MIGRATION_MAP[oldName];
  if (!entry) return null;
  return (
    `\`${oldName}\` was removed in the doc-14 MCP tool-surface refactor (May 2026); ` +
    `the b-36 canonical-ref refactor then collapsed all identity args to a single \`ref\` field. ` +
    `Replacement: \`${entry.replacement}\`. ${entry.note}`
  );
}

// b-42 t-4 — argument-name migration map. b-36 collapsed every entity-identity
// arg (docId, taskId, sectionId, missionId, decisionId, commentId) into a single
// canonical `ref` field. Stale clients (cached Claude Desktop configs, third-party
// MCP integrations built against pre-b-36 tool specs) keep sending the old names
// and hit a raw Zod error like "expected string, received undefined" on `ref`,
// with no migration path. This map powers a structured error that names the old
// field and the new canonical-ref form.
//
// Each value is the migration note appended to the structured error.
export const ARG_MIGRATIONS: Record<string, string> = {
  docId:
    "Use `ref` with a canonical doc ref (e.g. `<ns>/<mx>/briefs/b-N`, `<ns>/<mx>/docs/doc-N`, or `<ns>/<mx>/standards/std-N`).",
  taskId:
    "Use `ref` with a canonical task ref (e.g. `<ns>/<mx>/briefs/b-N/tasks/t-N`).",
  sectionId:
    "Use `ref` with a canonical section ref (e.g. `<ns>/<mx>/briefs/b-N/sections/s-N`).",
  missionId:
    "Use `ref` with a canonical Spec ref (e.g. `<ns>/<mx>/specs/spec-N`). Lineage: this entity was originally Strategy, renamed Mission, then Brief (b-26), then Spec (b-105). The legacy `missionId` arg name is preserved here so very old clients still get a structured migration error.",
  decisionId:
    "Use `ref` with a canonical decision ref (e.g. `<ns>/<mx>/briefs/b-N/decisions/dec-N`).",
  commentId:
    "Use `ref` with a canonical comment ref (e.g. `<ns>/<mx>/briefs/b-N/comments/c-N`).",
};

/**
 * Build the structured argument-migration error message for a tool call whose
 * arguments contain known-old field names. Returns null when no old names are
 * present (and the call should proceed to normal Zod validation).
 *
 * Fires even when both old and new args are passed — that's a confused client
 * mixing shapes, and silently ignoring `docId` while accepting `ref` would
 * obscure the bug.
 */
export function argMigrationErrorMessage(
  args: Record<string, unknown>,
): string | null {
  const oldKeys = Object.keys(args).filter((k) => k in ARG_MIGRATIONS);
  if (oldKeys.length === 0) return null;

  const header =
    oldKeys.length === 1
      ? `Argument \`${oldKeys[0]}\` is no longer accepted.`
      : `Arguments ${oldKeys.map((k) => `\`${k}\``).join(", ")} are no longer accepted.`;

  const detail = oldKeys.map((k) => `- \`${k}\`: ${ARG_MIGRATIONS[k]}`).join("\n");

  return (
    `${header} The b-36 canonical-ref refactor (May 2026) collapsed every entity-identity ` +
    `arg into a single \`ref\` field. Pass \`ref\` in canonical form ` +
    `(e.g. \`mindset/website-rewrite/briefs/b-1\` or \`mindset/website-rewrite/briefs/b-1/tasks/t-1\`).\n\n` +
    detail
  );
}
