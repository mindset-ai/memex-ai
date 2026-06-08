// b-67 t-1: single source of truth for the coding-agent tool reference.
// [per std-19] The coding-agent tool contract has one source: THIS manifest.
//
// This is the canonical, plain-data description of the coding-agent MCP tool
// surface — one entry per tool the MCP server registers. That is the server's
// `toolSpecs` array (packages/server/src/agent/tool-specs.ts) PLUS
// `list_memexes` (registered inline in mcp/tools.ts, not in toolSpecs). The
// agent-only `render_*` UI tools are NOT on MCP, so they are excluded here.
// Both surfaces consume THIS list:
//   - the server tool catalogue (tool-specs.ts) — the live MCP/agent specs.
//   - the React UI Init Prompt (packages/ui/src/utils/specInitPrompt.ts)
//     — the `MEMEX_MCP_TOOLS_REFERENCE` block pasted into coding agents.
//
// Keeping the reference here means the two surfaces can't drift apart: a
// regression test (b-67) asserts the manifest matches the live catalogue, so
// adding/removing/renaming a tool in tool-specs.ts forces a matching edit here.
//
// House style: plain data, dependency-free. No zod, no imports from the
// server package — just the names, summaries, argument signatures, and the
// phase grouping the Init Prompt renders under.
//
// `args` mirrors the Zod schema field order, with `?` on optional/defaulted
// fields. `group` mirrors the headings in the Init Prompt's
// MEMEX_MCP_TOOLS_REFERENCE: Read (any phase) → 'read', Planning phase →
// 'planning', Build phase → 'build', Comments → 'comments'.

import type { TrafficClass } from './spec-readiness.js';

export interface ToolManifestEntry {
  name: string;
  summary: string;
  args: string;
  group: 'read' | 'planning' | 'build' | 'comments';
  // std-16 / spec-156 ac-25: the MCP `readOnlyHint` annotation, carried HERE so
  // the manifest is the single source of the read-vs-mutating split. The server
  // catalogue (tool-specs.ts `annotations.readOnlyHint`) is asserted equal to
  // this in the b-67 cross-check; the mutate-coverage endpoint gate derives the
  // mutating tool set from `!readOnlyHint`.
  readOnlyHint: boolean;
  // spec-189 dec-4: how this tool's traffic reads against the Spec lifecycle,
  // feeding nextPhaseForTraffic (spec-readiness.ts). REQUIRED so adding a tool
  // forces a classification here — no standalone map that can drift.
  //   'specify' — decision authoring/resolution + AC authoring (dec-1)
  //   'build'   — task create/update/delete + issue registration/lifecycle
  //   'verify'  — AC verification (none on MCP today: verify-class traffic
  //               arrives via POST /api/test-events, wired server-side)
  //   null      — traffic that never drives a phase transition: all read-only
  //               tools, plus mutating tools that either (a) explicitly manage
  //               the lifecycle (update_doc / publish_spec / assess_spec —
  //               auto-advance must not fight deliberate placement, same
  //               principle as dec-5's rest_ui exclusion), (b) shape narrative
  //               (sections are legitimate draft-phase work and must not bump
  //               draft → specify; dec-1 scopes specify-class to decisions +
  //               ACs), or (c) target non-Spec entities (standards clauses).
  trafficClass: TrafficClass;
  // spec-189 dec-6/dec-5 corollary: mutating tools whose JOB is managing the
  // assignment/role axis (or that only notify humans) are exempt from
  // auto-assignment — otherwise unassign_spec(self) would instantly undo
  // itself. Absent = false: every other mutating tool auto-assigns its caller.
  autoAssignExempt?: boolean;
}

export const toolManifest: ToolManifestEntry[] = [
  // ── On-demand operating guidance ──────────────────────────
  {
    name: 'get_information',
    summary:
      "Fetch on-demand operating guidance. Call with no args for the topic index; call with topic='<slug>' for depth. Most operating guidance lives here (session-init prompt is intentionally tiny).",
    args: 'get_information(topic?)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  // ── Read (any phase) ──────────────────────────────────────
  {
    name: 'list_memexes',
    summary:
      'List the Memexes you have access to, grouped by namespace; call first when working across more than one.',
    args: 'list_memexes()',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'list_docs',
    summary:
      'List active Specs in a Memex with decision/task counts and lineage; filter by docType (defaults to spec) and/or tags.',
    args: 'list_docs(memex?, docType?, tags?)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'get_doc',
    summary:
      'Get a document with all sections, decisions, tasks, comments, blockers, plus its public URL.',
    args: 'get_doc(ref)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'export_doc',
    summary:
      'Export a spec as lossless markdown with every comment thread expanded inline at its anchor (for paste into an external LLM/editor).',
    args: 'export_doc(ref)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'list_tasks',
    summary:
      'List tasks on a document; readyOnly returns only unblocked, not-started tasks (replaces get_ready_tasks).',
    args: 'list_tasks(ref, readyOnly?)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'list_comments',
    summary:
      'List comments by target, by document, or by type; mode=review/task_notes shape the output.',
    args: 'list_comments(ref, types?, mode?)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'search_memex',
    summary:
      'Semantic + full-text search across Specs, Standards, docs, and Decisions in the active Memex.',
    args: 'search_memex(memex?, query, kind?, includeArchived?, includeCurrentDoc?, limit?)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'search_issues',
    summary:
      'Search Issues across the Memex (scoped to kind:issue) — cross-spec discovery of a bug/todo registered on any Spec.',
    args: 'search_issues(memex?, query, includeArchived?, limit?)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },

  // ── Planning phase (draft / specify) ──────────────────────
  {
    name: 'create_doc',
    summary:
      'Create a new Spec (or other docType); optional decisions seed, promoteFromTaskRef / promoteFromIssueRef preserves lineage.',
    args: 'create_doc(memex?, title, purpose?, docType?, decisions?, promoteFromTaskRef?, promoteFromIssueRef?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'update_doc',
    summary:
      "Update a document's status, title, and/or tags; transitions a Spec through draft→specify→build→verify→done.",
    args: 'update_doc(ref, status?, title?, tags?, removeTags?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'add_section',
    summary:
      'Add a new section to a document; the (doc, sectionType) pair is unique. STANDARDS are authored as clauses: pass clauses[] (one aspect each), not content; other doc types pass content. Wrong field for the doc type → rejected with guidance.',
    args: 'add_section(ref, sectionType, content?, clauses?, title?, description?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'update_section',
    summary:
      'Update the markdown content of a NON-standard document section (+ optional sectionType key / description). Blocked on standards — edit at the clause grain (add/edit/delete_clause). A sectionType collision fails with a readable error.',
    args: 'update_section(ref, content, sectionType?, description?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'add_clause',
    summary:
      'Append (or insert at a position) a clause to a STANDARD section — one self-contained aspect. Standards only; the new clause gets an addressable cl-N handle.',
    args: 'add_clause(ref, body, position?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'edit_clause',
    summary:
      "Edit a STANDARD clause's body by its cl-N ref; the section content (the join of its clauses) regenerates. Standards only.",
    args: 'edit_clause(ref, body)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'delete_clause',
    summary:
      'Soft-delete a STANDARD clause by its cl-N ref; the cl-N is frozen (never reused) and siblings are not resequenced. Standards only.',
    args: 'delete_clause(ref)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'retitle_section',
    summary:
      "Change a section's heading (and optionally its machine key); content is untouched. A sectionType collision fails with a readable error.",
    args: 'retitle_section(ref, title, sectionType?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'delete_section',
    summary:
      'Soft-delete a section (→ status=deleted); hidden from get_doc / lists / search but restorable. Remaining sections resequence to stay contiguous.',
    args: 'delete_section(ref)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'create_decision',
    summary:
      "Create a decision on a document; status='candidate' records an agent-extracted candidate awaiting review.",
    args: 'create_decision(ref, title, context?, status?, options?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'update_decision',
    summary:
      "Two modes: edit-in-place (title/context/resolution/chosenOptionIndex on any status) OR reopen (status='open' on a resolved decision). One per call. resolve_decision is the named verb for new resolutions.",
    args: 'update_decision(ref, status?, title?, context?, resolution?, chosenOptionIndex?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'delete_decision',
    summary:
      "Soft-delete a decision (→ status=deleted); hidden from get_doc / default list_decisions / UI tabs but queryable via ?include=deleted. No hard delete — update_decision restores it. Use when a decision was created in error (b-97).",
    args: 'delete_decision(ref)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'resolve_decision',
    summary:
      'Resolve a decision with an explanation; may unblock waiting tasks. chosenOptionIndex marks a structured option.',
    args: 'resolve_decision(ref, resolution, chosenOptionIndex?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'approve_candidate',
    summary:
      'Approve a candidate decision, transitioning it from status=candidate to status=open.',
    args: 'approve_candidate(ref)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'reject_candidate',
    summary:
      'Reject a candidate decision (→ status=rejected); the reason is preserved as the resolution.',
    args: 'reject_candidate(ref, reason)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'assess_spec',
    summary:
      'Run a deterministic Spec assessment: phase rubric, narrative freshness, comments survey, or consolidate.',
    args: 'assess_spec(ref, mode, target?, codeGrounding?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'publish_spec',
    summary:
      "Transition a Spec out of draft (defaults to 'specify'); refuses already-published Specs.",
    args: 'publish_spec(ref, status?)',
    group: 'planning',
    readOnlyHint: false,
    trafficClass: null,
  },

  // ── Build phase (build) ───────────────────────────────────
  {
    name: 'create_task',
    summary:
      'Create a task (build-phase only); resolve open decisions first. Include acceptance criteria.',
    args: 'create_task(ref, title, description, acceptanceCriteria?, sectionRef?)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'build',
  },
  {
    name: 'update_task',
    summary:
      'Update a task: status, title, description, acceptanceCriteria, sectionRef, add/removeBlockerRef.',
    args: 'update_task(ref, status?, title?, description?, acceptanceCriteria?, sectionRef?, addBlockerRef?, removeBlockerRef?)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'build',
  },
  {
    name: 'delete_task',
    summary: 'Delete a task; also removes its blockers and dependencies.',
    args: 'delete_task(ref)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'build',
  },

  // ── Standards protocol (build) ────────────────────────────
  // Restored by spec-143 dec-1 (the half of spec-63 dec-6 that was blocked on
  // the standards tooling returning). Both verbs reach the in-UI drift agent
  // and MCP coding agents; the write path enforces the standards-only invariant.
  {
    name: 'flag_drift',
    summary:
      "Flag drift on a standard section — post a typed `drift` comment (sourced 'agent') describing the gap between the rule and observed reality. Use when the rule is right but the code drifted; if the rule is wrong, use propose_standard_change.",
    args: 'flag_drift(ref, observation)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'propose_standard_change',
    summary:
      'Propose a corrected version of a standard section. Lands as a typed `plan_revision` comment (sourced \'agent\') with the full proposed replacement and a rationale, for the standard owner to accept or reject in the Drift Inbox.',
    args: 'propose_standard_change(ref, proposedContent, rationale?)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: null,
  },

  // ── Issues (any phase) ────────────────────────────────────
  {
    name: 'register_issue',
    summary:
      'Register a bug/todo Issue against a Spec (any phase). With NO spec_ref, persists nothing and returns a two-option assist (promote-to-Spec or a ranked list of active Specs) — no silent default home (std-5).',
    args: 'register_issue(memex?, spec_ref?, title, body, type, severity?, promote_to_spec?)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'build',
  },
  {
    name: 'list_issues',
    summary: 'List Issues on a Spec, optionally filtered by type (bug|todo) or status.',
    args: 'list_issues(ref, type?, status?)',
    group: 'build',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'get_issue',
    summary: 'Get a single Issue by canonical ref (returns type, status, severity, title, body).',
    args: 'get_issue(ref)',
    group: 'build',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'update_issue',
    summary: "Update an Issue's title/body/severity. Status transitions go through resolve_issue.",
    args: 'update_issue(ref, title?, body?, severity?)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'build',
  },
  {
    name: 'resolve_issue',
    summary: "Close out an Issue by setting its status to 'resolved' or 'wont_fix'.",
    args: 'resolve_issue(ref, resolution)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'build',
  },
  {
    name: 'convert_issue_to_task',
    summary:
      'Down-bridge: atomically pull an open Issue into an agent Task, mint a verifying implementation AC + task_satisfies_ac link, and set the Issue → converted. Auto-resolves when the Task completes and the AC goes green.',
    args: 'convert_issue_to_task(ref)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'build',
  },
  {
    name: 'kick_task_to_issue',
    summary:
      'Up-bridge (4th escalation): push an agent-impossible Task back into a human todo Issue and delete the Task. If the Task came from an issue→task conversion, reverts the origin Issue to open instead of duplicating.',
    args: 'kick_task_to_issue(ref, reason)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'build',
  },

  // ── Roles + assignment (any phase) ────────────────────────
  {
    name: 'set_spec_role',
    summary:
      "Set a user's role on a Spec: editor (promote) or reviewer (demote). Independent of assignment; no last-editor lock (a Spec may hold zero editors). Defaults to editor. Identify the user by email or id.",
    args: 'set_spec_role(ref, user, role?)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: null,
    autoAssignExempt: true,
  },
  {
    name: 'get_spec_roles',
    summary:
      "List a Spec's editors (reviewers are implicit and not enumerated) and report the caller's own resolved role. Read-only.",
    args: 'get_spec_roles(ref)',
    group: 'read',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'assign_spec',
    summary:
      'Assign a user to a Spec (ticket-style responsibility). Idempotent; independent of role (a reviewer can be assigned). Omit user to self-assign. Identify the user by email or id.',
    args: 'assign_spec(ref, user?)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: null,
    autoAssignExempt: true,
  },
  {
    name: 'unassign_spec',
    summary:
      "Remove a user's assignment from a Spec. Idempotent; leaves the user's role untouched. Identify the user by email or id.",
    args: 'unassign_spec(ref, user)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: null,
    autoAssignExempt: true,
  },

  // ── Acceptance Criteria (specify + build) ─────────────────
  {
    name: 'create_ac',
    summary:
      "Create an Acceptance Criterion under a Spec. kind='scope' (manager-authored, plain-English; parent=spec) or 'implementation' (agent-spawned from a resolved Decision; technical; pass parent_decision_ref).",
    args: "create_ac(ref, kind, statement, status?, parent_decision_ref?)",
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'list_acs',
    summary: 'List ACs on a Spec, optionally filtered by kind or status.',
    args: 'list_acs(ref, kind?, status?)',
    group: 'build',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'get_ac',
    summary: 'Get a single AC by canonical ref (returns kind, status, statement).',
    args: 'get_ac(ref)',
    group: 'build',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'get_test_matrix',
    summary:
      "Read an AC's per-test_identifier test-event digest by ref: latest status, emission count, and PINNING/retired flags. Use to find which identifier holds an AC red before retiring an orphan.",
    args: 'get_test_matrix(ref)',
    group: 'build',
    readOnlyHint: true,
    trafficClass: null,
  },
  {
    name: 'discontinue_test_events',
    summary:
      'Soft-hide an orphaned test_identifier on an AC (a test you renamed/deleted whose stale fail still pins the AC red). Reversible; audit retained; a fresh live emission re-enters the verdict. Only for identifiers gone from the codebase.',
    args: 'discontinue_test_events(ref, test_identifier)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'restore_test_events',
    summary:
      'Reverse discontinue_test_events: un-hide a test_identifier on an AC and recompute its verification badge from the restored history.',
    args: 'restore_test_events(ref, test_identifier)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'update_ac',
    summary:
      'Update an AC statement by ref. Only statement is mutable here; kind is fixed at creation; status transitions via accept_ac / reject_ac.',
    args: 'update_ac(ref, statement)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'delete_ac',
    summary:
      'Hard-delete an AC by ref. FKs cascade parent links and task_satisfies_ac. Prefer reject_ac for considered-and-dismissed ACs.',
    args: 'delete_ac(ref)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'specify',
  },
  {
    name: 'link_ac_to_decision',
    summary:
      "Attach a parent-Decision link to an existing AC (for cross-cutting Implementation ACs spawned from multiple Decisions). Typical Decision-spawned ACs use create_ac's parent_decision_ref instead.",
    args: 'link_ac_to_decision(ac_ref, decision_ref)',
    group: 'build',
    readOnlyHint: false,
    trafficClass: 'specify',
  },

  // ── Comments (any phase) ──────────────────────────────────
  {
    name: 'add_comment',
    summary:
      'Add a comment to a section, decision, or task; type=question surfaces a knowledge gap to the user. anchorOffset anchors a geo-comment to a point in a section.',
    args: 'add_comment(ref, authorName, content, type?, referenceRef?, anchorOffset?)',
    group: 'comments',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'update_comment',
    summary:
      "Update a comment; today status='resolved' resolves it with an optional resolution note.",
    args: 'update_comment(ref, status, resolution?)',
    group: 'comments',
    readOnlyHint: false,
    trafficClass: null,
  },
  {
    name: 'memex__send_slack_message',
    summary:
      "Send a Slack message as the current user via their connected Slack account — for AI→human handoffs.",
    args: 'memex__send_slack_message(memex?, channelOrUser, text, specRef?)',
    group: 'comments',
    readOnlyHint: false,
    trafficClass: null,
    autoAssignExempt: true,
  },
  {
    name: 'memex__send_discord_message',
    summary:
      "Send a message to the org's configured Discord webhook channel — for AI→human handoffs.",
    args: 'memex__send_discord_message(memex?, channelOrUser?, text, specRef?)',
    group: 'comments',
    readOnlyHint: false,
    trafficClass: null,
    autoAssignExempt: true,
  },
];
