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

import type { HomePhase } from './spec-readiness.js';

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
  // spec-464 dec-24: the phase in which this tool is IN-PHASE — its "home".
  // Single source of the tool→phase mapping (std-16); the phase gate at the
  // tool seam (runToolWithSpecTraffic) refuses an ahead-of-phase agent call
  // (homePhase strictly later than the Spec's current phase). REQUIRED so
  // adding a tool forces a classification here — no standalone map can drift.
  // Values per the Spec's Design Table 2:
  //   'specify' — decision authoring/resolution + scope-AC authoring. Allowed
  //               (with a publish nudge) one step early in draft; never a hard
  //               refuse — draft and specify share the planning toolset.
  //   'build'   — task/bridge tools, implementation-AC creation, write_qa_report
  //               (in-phase from build onward). Refused ahead (draft/specify).
  //   'verify'  — reserved; no tool homes here today (verify-class arrives via
  //               POST /api/test-events, wired server-side).
  //   null      — NEVER gated: all read-only tools, plus mutators that manage
  //               the lifecycle (update_doc / publish_spec / assess_spec /
  //               ground_spec), shape narrative (sections), park issues
  //               (register/update/resolve_issue — dec-19 gate-neutral), the
  //               emission tools (provision_ac_emission / discontinue_test_events
  //               — dec-10/11 ungated), or target non-Spec entities (clauses).
  // Both create_ac kinds are 'specify'-home (dec-10/11, resolved Option A):
  // scope AND implementation ACs are authored in specify — the specify→build
  // readiness gate requires an implementation AC per resolved decision BEFORE
  // build, so refusing them ahead of build would make that gate unsatisfiable.
  // They are never ahead-refused; only tasks + write_qa_report are build-home.
  homePhase: HomePhase;
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
    homePhase: null,
  },
  // ── Read (any phase) ──────────────────────────────────────
  {
    name: 'list_memexes',
    summary:
      'List the Memexes you have access to, grouped by namespace; call first when working across more than one.',
    args: 'list_memexes()',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'list_docs',
    // spec-521 dec-3 (ac-13): std-16 requires the summary to STATE the default in
    // words. The old summary said "active Specs" without saying that draft and done
    // were being dropped, which is how a silently narrowed answer passed for a
    // complete one.
    summary:
      'List Specs in a Memex with decision/task counts and lineage. Default is EVERY phase (draft, specify, build, verify, done) with archived the only exclusion; superseded Specs are included and marked with their successor. The response header states the total, the number shown, and what was withheld. Pass statusIn to narrow, docType (defaults to spec) and/or tags to filter.',
    args: 'list_docs(memex?, docType?, statusIn?, tags?)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'get_doc',
    summary:
      'Get a document with all sections, decisions, tasks, comments, blockers, plus its public URL.',
    args: 'get_doc(ref)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    // spec-263 dec-3/dec-4: the when-to-call lives in the summary, not just the
    // what — the tool meets the agent at the handoff moments (orienting on a
    // Spec, landing in a new phase).
    name: 'get_prompt',
    summary:
      "Get the handoff prompt for a Spec's current phase — the exact text the web UI's copy-prompt button produces (specify/build/verify; draft/done carry none). Call after orienting on a Spec or right after a phase transition.",
    args: 'get_prompt(ref)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'export_doc',
    summary:
      'Export a spec as lossless markdown with every comment thread expanded inline at its anchor (for paste into an external LLM/editor).',
    args: 'export_doc(ref)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'list_tasks',
    summary:
      'List tasks on a document; readyOnly returns only unblocked, not-started tasks (replaces get_ready_tasks).',
    args: 'list_tasks(ref, readyOnly?)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'list_comments',
    summary:
      'List comments by target, by document, or by type; mode=review/task_notes shape the output.',
    args: 'list_comments(ref, types?, mode?)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'search_memex',
    summary:
      'Semantic + full-text search across Specs, Standards, docs, and Decisions in the active Memex.',
    args: 'search_memex(memex?, query, kind?, includeArchived?, includeCurrentDoc?, limit?)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'search_issues',
    summary:
      'Search Issues across the Memex (scoped to kind:issue) — cross-spec discovery of a bug/todo registered on any Spec.',
    args: 'search_issues(memex?, query, includeArchived?, limit?)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },

  // ── Planning phase (draft / specify) ──────────────────────
  {
    name: 'create_doc',
    summary:
      'Create a new Spec (or other docType); optional decisions seed, promoteFromTaskRef / promoteFromIssueRef preserves lineage.',
    args: 'create_doc(memex?, title, purpose?, docType?, decisions?, promoteFromTaskRef?, promoteFromIssueRef?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'update_doc',
    summary:
      "Update a document's status, title, and/or tags; transitions a Spec through draft→specify→build→verify→done.",
    args: 'update_doc(ref, status?, title?, tags?, removeTags?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  // spec-418 t-4: tag-catalogue curation. These manage the Memex's tag VOCABULARY
  // itself (create / rename / delete a `scope::value`/flat tag), distinct from
  // update_doc's tags/removeTags which attach an existing tag to one Spec. Thin
  // wrappers over the same tags-service functions REST calls. trafficClass null —
  // curating the shared vocabulary never drives a Spec's phase.
  {
    name: 'create_tag',
    summary:
      'Create a new tag in the Memex\'s shared vocabulary — a `scope::value` (e.g. `priority::high`) or flat (e.g. `bug`) label. Refuses (case-insensitively, naming the existing tag) rather than minting a near-duplicate.',
    args: 'create_tag(memex?, tag)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'rename_tag',
    summary:
      'Rename an existing tag; the new name is reflected on every Spec that carried it, in one operation. Refuses with a plain reason (no change) if the new name duplicates another tag or would put two values of one scope on a Spec.',
    args: 'rename_tag(memex?, tag, newTag)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'delete_tag',
    summary:
      'Delete a tag from the vocabulary; it is removed from every Spec that carried it, leaving those Specs otherwise untouched. Irreversible, never blocked, one tag per call (no bulk form).',
    args: 'delete_tag(memex?, tag)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'add_section',
    summary:
      'Add a section to a document; (doc, sectionType) is unique. STANDARDS pass clauses[] (one aspect each) plus a parallel clauseFacets[] verdict (where a vocabulary exists); other doc types pass content. Wrong field is rejected.',
    args: 'add_section(ref, sectionType, content?, clauses?, clauseFacets?, title?, description?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'update_section',
    summary:
      'Replace the ENTIRE markdown body of a NON-standard section (+ optional sectionType / description); for a targeted edit prefer edit_section. Blocked on standards: edit at clause grain. A sectionType collision fails with a readable error.',
    args: 'update_section(ref, content, sectionType?, description?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  // spec-503: the surgical sibling of update_section. A targeted change costs
  // one oldText/newText pair, never a re-emission of the whole section body.
  {
    name: 'edit_section',
    summary:
      'Surgical find/replace inside a NON-standard section: ONE literal oldText/newText pair, the cheap way to make a targeted change (no body re-emission). Zero or ambiguous matches fail naming the remedy; replaceAll replaces every hit.',
    args: 'edit_section(ref, oldText, newText, replaceAll?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'add_clause',
    summary:
      'Append (or insert at a position) a clause to a STANDARD section — one self-contained aspect. Standards only; the new clause gets an addressable cl-N handle.',
    args: 'add_clause(ref, body, position?, facets?, testability?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'edit_clause',
    summary:
      "Edit a STANDARD clause's body by its cl-N ref; the section content (the join of its clauses) regenerates. Standards only.",
    args: 'edit_clause(ref, body, facets?, testability?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'delete_clause',
    summary:
      'Soft-delete a STANDARD clause by its cl-N ref; the cl-N is frozen (never reused) and siblings are not resequenced. Standards only.',
    args: 'delete_clause(ref)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'retitle_section',
    summary:
      "Change a section's heading (and optionally its machine key); content is untouched. A sectionType collision fails with a readable error.",
    args: 'retitle_section(ref, title, sectionType?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'delete_section',
    summary:
      'Soft-delete a section (→ status=deleted); hidden from get_doc / lists / search but restorable. Remaining sections resequence to stay contiguous.',
    args: 'delete_section(ref)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'create_decision',
    summary:
      "Create a decision on a document; status='candidate' records an agent-extracted candidate awaiting review.",
    args: 'create_decision(ref, title, context?, status?, options?, facetBallot?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: 'specify',
  },
  {
    name: 'update_decision',
    summary:
      "Two modes: edit-in-place (title/context/resolution/chosenOptionIndex/facetBallot on any status) OR reopen (status='open' on a resolved decision). One per call; resolve_decision is the named verb for new resolutions.",
    args: 'update_decision(ref, status?, title?, context?, resolution?, chosenOptionIndex?, facetBallot?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: 'specify',
  },
  {
    name: 'delete_decision',
    summary:
      "Soft-delete a decision (→ status=deleted); hidden from get_doc / default list_decisions / UI tabs but queryable via ?include=deleted. No hard delete — update_decision restores it. Use when a decision was created in error (b-97).",
    args: 'delete_decision(ref)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: 'specify',
  },
  {
    name: 'resolve_decision',
    summary:
      'Resolve a decision; may unblock waiting tasks. chosenOptionIndex marks a structured option — resolution is then optional (defaults to its label). Re-resolving updates the choice in place.',
    args: 'resolve_decision(ref, resolution?, chosenOptionIndex?, facetBallot?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: 'specify',
  },
  {
    name: 'approve_candidate',
    summary:
      'Approve a candidate decision, transitioning it from status=candidate to status=open.',
    args: 'approve_candidate(ref)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: 'specify',
  },
  {
    name: 'reject_candidate',
    summary:
      'Reject a candidate decision (→ status=rejected); the reason is preserved as the resolution.',
    args: 'reject_candidate(ref, reason)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: 'specify',
  },
  {
    name: 'assess_spec',
    summary:
      'Run a deterministic Spec assessment: phase rubric, narrative freshness, comments survey, or consolidate.',
    args: 'assess_spec(ref, mode, target?, codeGrounding?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'publish_spec',
    summary:
      "Transition a Spec out of draft (defaults to 'specify'); refuses already-published Specs.",
    args: 'publish_spec(ref, status?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'ground_spec',
    summary:
      'Mark a Spec code-grounded (decisions verified against current source); MCP-only, requires codebase_present. Stamps who/when as a verification badge.',
    args: 'ground_spec(ref, codebase_present)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    // spec-521 dec-5. homePhase: null — supersession is not phase-bound; a Spec can
    // be superseded at any point in its life, including after it is done.
    name: 'supersede_spec',
    summary:
      'Record that one Spec supersedes another (it shipped, a later Spec changed it). Non-destructive: content still served, but every read of the superseded Spec and its children leads with a pointer to the successor, which carries the mirror. Pass supersededBy: null to clear. Doc-level only; cycles refused. NOT archiving — archiving withholds content and is human-only.',
    args: 'supersede_spec(ref, supersededBy, note?)',
    group: 'planning',
    readOnlyHint: false,
    homePhase: null,
  },

  // ── Build phase (build) ───────────────────────────────────
  {
    name: 'create_task',
    summary:
      'Create a task (build-phase only); resolve open decisions first. Include acceptance criteria.',
    args: 'create_task(ref, title, description, acceptanceCriteria?, sectionRef?, facetBallot?)',
    group: 'build',
    readOnlyHint: false,
    // spec-464 dec-7/dec-8/dec-9: tasks are home to BUILD. Refused ahead of
    // build (draft/specify) by the phase gate — which subsumes the spec-327
    // createTask service guard (that guard is removed; the seam covers it now).
    homePhase: 'build',
  },
  {
    name: 'update_task',
    summary:
      'Update a task: status, title, description, acceptanceCriteria, sectionRef, facetBallot (re-cast facets), add/removeBlockerRef.',
    args: 'update_task(ref, status?, title?, description?, acceptanceCriteria?, sectionRef?, addBlockerRef?, removeBlockerRef?, facetBallot?)',
    group: 'build',
    readOnlyHint: false,
    homePhase: 'build',
  },
  {
    name: 'delete_task',
    summary: 'Delete a task; also removes its blockers and dependencies.',
    args: 'delete_task(ref)',
    group: 'build',
    readOnlyHint: false,
    homePhase: 'build',
  },
  {
    name: 'write_qa_report',
    summary:
      'Persist a QA Report on a Spec at the build→verify hand-off — a reviewer-facing record of what this build session changed (front-end, back-end, testing, gaps, deviations, deploy notes). Appends a new dated version; never overwrites.',
    args: 'write_qa_report(ref, content, title?)',
    group: 'build',
    readOnlyHint: false,
    // spec-464 dec-14/15/16/17: the QA report is the build→verify hand-off and is
    // in-phase from BUILD onward (home 'build'; verify is behind-home, allowed).
    // Refused only ahead of build (draft/specify) — nothing has been built yet.
    homePhase: 'build',
  },

  // ── Standards protocol (build) ────────────────────────────
  // Restored by spec-143 dec-1 (the half of spec-63 dec-6 that was blocked on
  // the standards tooling returning). Both verbs reach the in-UI drift agent
  // and MCP coding agents; the write path enforces the standards-only invariant.
  {
    name: 'flag_drift',
    summary:
      "Flag drift on a standard section — post a typed `drift` comment (sourced 'agent') describing the gap between the rule and observed reality. Use when the rule is right but the code drifted; if the rule is wrong, use propose_standard_change.",
    args: 'flag_drift(ref, observation, decisionRef?)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'propose_standard_change',
    summary:
      'Propose a correction to a standard\'s rule text, at the clause grain: name the clauses that should change and what they should say. Lands as a typed `plan_revision` comment (sourced \'agent\') for the standard owner to accept or reject in the Drift Inbox. Every clause in one proposal must belong to the same section, and you never supply a clause\'s current text — the server reads it, so an accept can tell whether the clause moved underneath the proposal.',
    args: 'propose_standard_change(operations, rationale?)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'accept_standard_change',
    summary:
      "Accept an open proposal (a `plan_revision` comment) and apply it to the Standard: every clause operation the proposal carries lands, or none does, and the proposal is resolved 'accepted' in the same transaction. Takes the comment ref and nothing else, so what is applied is exactly what was reviewed. Refuses \u2014 naming the clause and its current text \u2014 if the rule changed after the proposal was written, rather than overwriting that change.",
    args: 'accept_standard_change(ref)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'facets',
    summary:
      "Check which parts of your Standards apply to a piece of work: lists the topics they are tagged by (the Memex's facets). Cast these as the facetBallot on create_task / create_decision and Memex surfaces the governing standard sections.",
    args: 'facets(verb, memex?)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },

  // ── Issues (any phase) ────────────────────────────────────
  {
    name: 'register_issue',
    summary:
      'Register a bug/todo Issue against a Spec (any phase). With NO spec_ref, persists nothing and returns a two-option assist (promote-to-Spec or a ranked list of active Specs) — no silent default home (std-5).',
    args: 'register_issue(memex?, spec_ref?, title, body, type, severity?, promote_to_spec?)',
    group: 'build',
    readOnlyHint: false,
    // spec-295 dec-2: NON-ADVANCING. An Issue is the gate-neutral parking lot —
    // raising one (a parked todo or a bug) must never auto-advance the Spec's
    // phase, on any surface. Previously 'build', which shoved a specify Spec to
    // build on capture, contradicting the "gate-neutral" framing. Issues are
    // raiseable in any phase and move nothing.
    homePhase: null,
  },
  {
    name: 'list_issues',
    summary: 'List Issues on a Spec, optionally filtered by type (bug|todo) or status.',
    args: 'list_issues(ref, type?, status?)',
    group: 'build',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'get_issue',
    summary: 'Get a single Issue by canonical ref (returns type, status, severity, title, body).',
    args: 'get_issue(ref)',
    group: 'build',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'update_issue',
    summary: "Update an Issue's title/body/severity. Status transitions go through resolve_issue.",
    args: 'update_issue(ref, title?, body?, severity?)',
    group: 'build',
    readOnlyHint: false,
    // spec-464 dec-19: GATE-NEUTRAL. An Issue is the parking lot (spec-295) —
    // its whole lifecycle (register/update/resolve) runs in any phase and moves
    // nothing. Corrects the surviving inconsistency where update/resolve_issue
    // were still 'build'-class. (convert_issue_to_task / kick_task_to_issue mint
    // or destroy a TASK, so they follow the task rules and stay 'build'.)
    homePhase: null,
  },
  {
    name: 'resolve_issue',
    summary: "Close out an Issue by setting its status to 'resolved' or 'wont_fix'.",
    args: 'resolve_issue(ref, resolution)',
    group: 'build',
    readOnlyHint: false,
    // spec-464 dec-19: GATE-NEUTRAL (see update_issue).
    homePhase: null,
  },
  {
    name: 'convert_issue_to_task',
    summary:
      'Down-bridge: atomically pull an open Issue into an agent Task, mint a verifying implementation AC + task_satisfies_ac link, and set the Issue → converted. Auto-resolves when the Task completes and the AC goes green.',
    args: 'convert_issue_to_task(ref)',
    group: 'build',
    readOnlyHint: false,
    homePhase: 'build',
  },
  {
    name: 'kick_task_to_issue',
    summary:
      'Up-bridge (4th escalation): push an agent-impossible Task back into a human todo Issue and delete the Task. If the Task came from an issue→task conversion, reverts the origin Issue to open instead of duplicating.',
    args: 'kick_task_to_issue(ref, reason)',
    group: 'build',
    readOnlyHint: false,
    homePhase: 'build',
  },

  // ── Roles + assignment (any phase) ────────────────────────
  {
    name: 'set_spec_role',
    summary:
      "Set a user's role on a Spec: editor (promote) or reviewer (demote). Independent of assignment; no last-editor lock (a Spec may hold zero editors). Defaults to editor. Identify the user by email or id.",
    args: 'set_spec_role(ref, user, role?)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
    autoAssignExempt: true,
  },
  {
    name: 'get_spec_roles',
    summary:
      "List a Spec's editors (reviewers are implicit and not enumerated) and report the caller's own resolved role. Read-only.",
    args: 'get_spec_roles(ref)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'assign_spec',
    summary:
      'Assign a user to a Spec (ticket-style responsibility). Idempotent; independent of role (a reviewer can be assigned). Omit user to self-assign. Identify the user by email or id.',
    args: 'assign_spec(ref, user?)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
    autoAssignExempt: true,
  },
  {
    name: 'unassign_spec',
    summary:
      "Remove a user's assignment from a Spec. Idempotent; leaves the user's role untouched. Identify the user by email or id.",
    args: 'unassign_spec(ref, user)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
    autoAssignExempt: true,
  },
  {
    name: 'claim_spec',
    summary:
      "Check out a Spec for the thread you're working in — the explicit nomination that binds this coding session to it. Writes a soft presence marker (a courtesy lock, never a hard block) and returns who else holds it. Idempotent.",
    args: 'claim_spec(ref)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
    autoAssignExempt: true,
  },
  {
    name: 'unclaim_spec',
    summary:
      "Release your checkout on a Spec — the explicit check-in. Clears your presence marker and returns the thread to the silent default. No-op if you weren't holding it.",
    args: 'unclaim_spec(ref)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
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
    // spec-464 dec-5/dec-6 + dec-10/11 (revised): BOTH AC kinds are authored in
    // specify. Scope ACs pin what "done" means; implementation ACs pin what
    // proves each resolved decision — and the specify→build readiness gate
    // (assess_spec + spec-391 + the create_ac coverage footer) REQUIRES an
    // implementation AC per resolved decision BEFORE the build move, so gating
    // impl-AC creation ahead of build would make that gate unsatisfiable. Home is
    // 'specify' for both kinds; no per-kind elevation.
    homePhase: 'specify',
  },
  {
    name: 'list_acs',
    summary: 'List ACs on a Spec, optionally filtered by kind or status.',
    args: 'list_acs(ref, kind?, status?)',
    group: 'build',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    // spec-234: agent-facing AC-emission onboarding. Mints an ephemeral, spec-scoped
    // key AND returns the wire-it-up guidance in one call. homePhase null — it sets
    // up emission, it does not itself drive a Spec phase transition.
    name: 'provision_ac_emission',
    summary:
      "Provision AC emission for this Spec in one call: mints an ephemeral, spec-scoped emission key (session-only, never persist) and returns the wiring guidance for the repo's test runners. No Settings detour; CI keys stay human-minted.",
    args: 'provision_ac_emission(ref)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'get_ac',
    summary: 'Get a single AC by canonical ref (returns kind, status, statement).',
    args: 'get_ac(ref)',
    group: 'build',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'get_test_matrix',
    summary:
      "Read an AC's per-test_identifier test-event digest by ref: latest status, emission count, and PINNING/retired flags. Use to find which identifier holds an AC red before retiring an orphan.",
    args: 'get_test_matrix(ref)',
    group: 'build',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'discontinue_test_events',
    summary:
      'Hard-delete an orphaned test_identifier on an AC (a renamed/deleted test whose stale fail pins the AC red): removes its emissions + summary. Irreversible; a fresh emission re-enters the verdict. Only for identifiers gone from the code.',
    args: 'discontinue_test_events(ref, test_identifier)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'update_ac',
    summary:
      'Update an AC statement by ref. Only statement is mutable here; kind is fixed at creation; status transitions via accept_ac / reject_ac.',
    args: 'update_ac(ref, statement)',
    group: 'build',
    readOnlyHint: false,
    homePhase: 'specify',
  },
  {
    name: 'delete_ac',
    summary:
      'Hard-delete an AC by ref. FKs cascade parent links and task_satisfies_ac. Prefer reject_ac for considered-and-dismissed ACs.',
    args: 'delete_ac(ref)',
    group: 'build',
    readOnlyHint: false,
    homePhase: 'specify',
  },
  {
    name: 'link_ac_to_decision',
    summary:
      "Attach a parent-Decision link to an existing AC (for cross-cutting Implementation ACs spawned from multiple Decisions). Typical Decision-spawned ACs use create_ac's parent_decision_ref instead.",
    args: 'link_ac_to_decision(ac_ref, decision_ref)',
    group: 'build',
    readOnlyHint: false,
    homePhase: 'specify',
  },

  // ── Skills (spec-300) ─────────────────────────────────────
  {
    name: 'list_skills',
    summary:
      "List active Skills alphabetically: name, description, capability flags, ref (never the SKILL.md body). Pass all_memexes:true to find a named skill across your Memexes; if it appears in more than one Memex, ALWAYS ask which to use.",
    args: 'list_skills(memex?, all_memexes?)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'get_skill',
    summary:
      "Read one Skill: the verbatim SKILL.md body + a table-of-contents of its auxiliary files (no inline contents). Pass path to fetch one file (binary → signed URL, text → inline); working_spec_ref meters usage.",
    args: 'get_skill(ref, working_spec_ref?, path?)',
    group: 'read',
    readOnlyHint: true,
    homePhase: null,
  },
  {
    name: 'update_skill',
    summary:
      'Create, edit, delete, or restore a Skill: import SKILL.md files into a Memex. create: memex + skill_md (+ capabilities/files); edit: ref + skill_md/capabilities/files (add/replace)/remove_files; delete/restore: ref.',
    args: 'update_skill(verb, memex?, ref?, skill_md?, capabilities?, files?, remove_files?)',
    group: 'build',
    readOnlyHint: false,
    homePhase: null,
  },

  // ── Comments (any phase) ──────────────────────────────────
  {
    name: 'add_comment',
    summary:
      'Add a comment to a section, decision, or task; type=question surfaces a knowledge gap to the user. anchorOffset anchors a geo-comment to a point in a section.',
    args: 'add_comment(ref, authorName, content, type?, referenceRef?, anchorOffset?)',
    group: 'comments',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'update_comment',
    summary:
      "Update a comment; today status='resolved' resolves it with an optional resolution note.",
    args: 'update_comment(ref, status, resolution?)',
    group: 'comments',
    readOnlyHint: false,
    homePhase: null,
  },
  {
    name: 'memex__send_slack_message',
    summary:
      "Send a Slack message as the current user via their connected Slack account — for AI→human handoffs.",
    args: 'memex__send_slack_message(memex?, channelOrUser, text, specRef?)',
    group: 'comments',
    readOnlyHint: false,
    homePhase: null,
    autoAssignExempt: true,
  },
  {
    name: 'memex__send_discord_message',
    summary:
      "Send a message to the org's configured Discord webhook channel — for AI→human handoffs.",
    args: 'memex__send_discord_message(memex?, channelOrUser?, text, specRef?)',
    group: 'comments',
    readOnlyHint: false,
    homePhase: null,
    autoAssignExempt: true,
  },
];
