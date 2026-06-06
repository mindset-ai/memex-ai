import {
  BASE_SCAFFOLD,
  toInitPromptRef,
  type InitPromptRefEntry,
  type ToolNode,
} from '@memex/shared';
import type { DocWithGraph } from '../api/types';

/**
 * Generates the "Init Prompt" — a self-contained briefing pasted into a fresh
 * coding-agent session so it can immediately orient itself around a specific
 * memex spec.
 *
 * The prompt is assembled from named template fragments below. Each fragment
 * is an editable, self-contained template-literal function (or constant string)
 * so we can tune wording in isolation as the workflow evolves.
 */

interface SpecSummary {
  handle: string;
  docId: string;
  title: string;
  docType: string;
  status: string;
  sectionTitles: string[];
  openDecisions: number;
  resolvedDecisions: number;
  readyTasks: number;
  blockedTasks: number;
  inProgressTasks: number;
  completedTasks: number;
  totalTasks: number;
  unresolvedComments: number;
}

export type InitPromptMode = 'evolve' | 'specify' | 'execute' | 'decisions' | 'comments' | 'freeform';

export interface InitPromptModeDef {
  label: string;
  description: string;
  focus: (s: SpecSummary) => string;
}

export function renderSpecInitPrompt(
  doc: DocWithGraph,
  unresolvedComments: number,
  mode: InitPromptMode = 'freeform',
): string {
  const s = summarize(doc, unresolvedComments);
  const focus = INIT_PROMPT_MODES[mode].focus(s);
  return [INTRO(s), STATUS(s), MEMEX_MCP_TOOLS_REFERENCE, focus].join('\n\n').trim() + '\n';
}

function summarize(doc: DocWithGraph, unresolvedComments: number): SpecSummary {
  const decisions = doc.decisions ?? [];
  const tasks = doc.tasks ?? [];
  const sections = [...doc.sections].sort((a, b) => a.seq - b.seq);

  return {
    handle: doc.handle,
    docId: doc.id,
    title: doc.title,
    docType: doc.docType,
    status: doc.status,
    sectionTitles: sections.map((s) => s.title ?? s.sectionType),
    openDecisions: decisions.filter((d) => d.status === 'open').length,
    resolvedDecisions: decisions.filter((d) => d.status === 'resolved').length,
    readyTasks: tasks.filter((t) => !t.blocked && t.status === 'not_started').length,
    blockedTasks: tasks.filter((t) => t.blocked).length,
    inProgressTasks: tasks.filter((t) => t.status === 'in_progress').length,
    completedTasks: tasks.filter((t) => t.status === 'complete').length,
    totalTasks: tasks.length,
    unresolvedComments,
  };
}

// ── Editable prompt fragments ─────────────────────────────────────────────
// Tune wording here. Each fragment is independent — no cross-references.

const INTRO = (s: SpecSummary) => `You are joining an active coding session to work on a memex **${s.docType}** document.

- **${titleCase(s.docType)}:** ${s.title}
- **Handle:** \`${s.handle}\`
- **Status:** ${s.status}

A memex document is a structured, evolving artifact composed of:
- **Sections** — markdown content describing context, approach, scope, etc.
- **Decisions** — open questions that may block progress until resolved
- **Tasks** — concrete tasks with acceptance criteria, optionally blocked by decisions or other tasks
- **Comments** — discussion threads anchored to any section, decision, or task

Specs move through phases: \`draft → specify → build → verify → done\`. Decisions are shaped in \`draft\`/\`specify\`; **tasks only exist from \`build\` onward**. Don't create tasks while the spec is in a specifying phase — resolve the open decisions first.

Your job is to help the user advance this document. Keep the document itself as the source of truth: log decisions, create and update tasks (once in \`build\`), and record progress there rather than in chat.`;

const STATUS = (s: SpecSummary) => `## Current status

- **Sections (${s.sectionTitles.length}):** ${s.sectionTitles.map((t) => `_${t}_`).join(', ') || 'none'}
- **Decisions:** ${s.openDecisions} open, ${s.resolvedDecisions} resolved
- **Tasks:** ${s.readyTasks} ready, ${s.inProgressTasks} in progress, ${s.blockedTasks} blocked, ${s.completedTasks}/${s.totalTasks} complete
- **Unresolved comments:** ${s.unresolvedComments}`;

// Shared block: the "how to talk back to Memex" reference. The same surface
// shows up in the spec init prompt and in the per-task init prompt — they
// describe the same MCP server. The tool list itself is RENDERED from the
// unified scaffold model `BASE_SCAFFOLD.tools` in `@memex/shared` (b-68 t-9),
// projected through `toInitPromptRef` so the Init Prompt can never drift from
// the live MCP catalogue. [per std-16] — do not hand-list tools here; the prose
// must not name a tool absent from the unified model. Only the wrapper prose
// below — the intro, the ref-grammar block, and the closing phase-transition +
// error guidance — is hand-authored; tune wording there.

// Per-group headings, in render order. Keeps the tone of the previous
// hand-maintained list while sourcing the actual tools from the scaffold model.
const TOOL_GROUP_HEADINGS: Record<InitPromptRefEntry['group'], string> = {
  read: '### Read (any phase)',
  planning: '### Specify phase (`draft` / `specify`)',
  build: '### Build phase (`build`)',
  comments: '### Comments (any phase)',
};

const TOOL_GROUP_ORDER: InitPromptRefEntry['group'][] = ['read', 'planning', 'build', 'comments'];

/** Render the live tool surface from `BASE_SCAFFOLD.tools`, projected through
 *  `toInitPromptRef`, grouped by phase. One line per tool:
 *  `` - `<args>` — <summary> ``. Empty groups emit no heading. */
function renderToolReference(tools: readonly ToolNode[]): string {
  const refs = tools.map(toInitPromptRef);
  return TOOL_GROUP_ORDER.flatMap((group) => {
    const entries = refs.filter((e) => e.group === group);
    if (entries.length === 0) return [];
    const lines = entries.map((e) => `- \`${e.args}\` — ${e.summary}`);
    return [[TOOL_GROUP_HEADINGS[group], ...lines].join('\n')];
  }).join('\n\n');
}

const TOOLS_INTRO = `## Tools available to you

You have access to the \`memex\` MCP server. Memex specs move through phases — \`draft → specify → build → verify → done\` — and the tool you reach for depends on which phase the spec is in. **Tasks are only created in \`build\`. Don't create tasks while the spec is in \`draft\` or \`specify\` — that's where decisions get shaped.**

### Addressing things in Memex

Every entity-acting tool takes a single \`ref\` argument — a **canonical path** that uniquely names what you're addressing:

\`\`\`
<namespace>/<memex>/<doc-type>/<doc-handle>[/<child-type>/<child-handle>]
\`\`\`

- \`<doc-type>\` is one of \`specs\` / \`docs\` / \`standards\` / \`execution-plans\`.
- \`<doc-handle>\` is \`spec-N\` for specs, \`doc-N\` for free-form docs and execution-plans, \`std-N\` for standards.
- \`<child-type>\` is one of \`sections\` / \`decisions\` / \`tasks\` / \`comments\`.
- \`<child-handle>\` is \`s-N\` / \`dec-N\` / \`t-N\` / \`c-N\`.

Examples: \`mindset/website-rewrite/specs/spec-12\`, \`mindset/website-rewrite/specs/spec-12/tasks/t-3\`, \`mindset/website-rewrite/standards/std-5/sections/s-2\`.

Memex-scoped tools (those that operate on a workspace rather than a specific entity, like \`list_docs\` or \`search_memex\`) take a separate \`memex\` argument in \`<namespace>/<memex>\` form — the same string the user types in the browser. **No tool takes both \`ref\` and \`memex\`** — the ref already includes the memex segments, and the memex-scoped tools don't address a specific entity. UUIDs are no longer accepted by any tool; if you have one, look up the canonical ref via \`get_doc\` first.

(Standards verbs are temporarily disabled — there's no tool to flag drift against a rule or propose a change to one yet. Stay watchful for standards drift anyway: if a rule is wrong, or existing code diverges from one, surface it to the user and capture a decision. When **no rule exists yet** for an area and a pattern stabilises, write one with \`create_doc({ memex, title, sections, docType: 'standard' })\`.)`;

const TOOLS_OUTRO = `**Phase transitions are agent-driven except one:** \`verify\` → \`done\` is human-only — never call \`update_doc\` with \`status: "done"\`.

**On errors:** if a tool rejects a UUID with *"UUID inputs no longer accepted; pass the ref"*, you're using a legacy identifier — fetch the parent with \`get_doc\` (or \`list_docs\`), then call again with the canonical \`ref\`.`;

export const MEMEX_MCP_TOOLS_REFERENCE = [
  TOOLS_INTRO,
  renderToolReference(BASE_SCAFFOLD.tools),
  TOOLS_OUTRO,
].join('\n\n');

// ── Mode-specific focus (the "How to start" section) ─────────────────────
// One entry per mode. Edit freely — each entry is self-contained.

export const INIT_PROMPT_MODES: Record<InitPromptMode, InitPromptModeDef> = {
  evolve: {
    label: 'Evolve the document',
    description: 'Refine and grow the document itself — tighten sections, add missing ones, surface decisions.',
    focus: (s) => `## How to start

1. Call \`list_memexes()\` to confirm the workspace, then \`get_doc("<memex>/${docTypePath(s.docType)}/${s.handle}")\` to load the current state (${s.sectionTitles.length} sections, ${s.openDecisions} open decisions). Substitute the user's \`<namespace>/<memex>\` for \`<memex>\`.
2. Read the existing sections carefully. Identify what's weak, missing, or ambiguous — e.g. unclear goals, hand-waved approach, missing scope, vague success criteria, unspecified non-goals.
3. Work with the user to evolve the document:
   - Use \`update_section(<section-ref>, content)\` to tighten existing sections — \`<section-ref>\` is the doc ref plus \`/sections/s-N\`.
   - Use \`add_section(<doc-ref>, sectionType, content, title?)\` to add missing context (e.g. "scope", "non-goals", "risks", "open-questions").
   - When a genuine choice surfaces that would block progress, log it with \`create_decision(<doc-ref>, title, context?)\` rather than hiding it in prose.
   - When concrete work emerges (and you're past planning), capture it with \`create_task(<doc-ref>, ...)\`.
4. Propose changes before making them — show the user the before/after or the new section content, get agreement, then apply. The document is the source of truth; keep it coherent.`,
  },

  specify: {
    label: 'Specify next work',
    description: 'Decision-first specifying. Resolve every open decision before any task is created.',
    focus: (s) => `## How to start

1. Call \`list_memexes()\` to confirm the workspace, then \`get_doc("<memex>/${docTypePath(s.docType)}/${s.handle}")\` to load the current state. Spec status: \`${s.status}\`. Substitute the user's \`<namespace>/<memex>\` for \`<memex>\`.
2. **You are in the specify phase. Do not create tasks.** The work is the spec narrative and the decisions that flow from it.
3. ${s.openDecisions === 0
        ? 'There are no open decisions. Make sure the spec narrative is coherent and complete, then move to `build` so tasks can be created.'
        : `There are ${s.openDecisions} open decisions. Walk them one at a time:
   - Present the title, context, and options (with trade-offs you can infer from the document).
   - When the user picks, call \`resolve_decision(<decision-ref>, resolution)\` with a concise note — \`<decision-ref>\` is the doc ref plus \`/decisions/dec-N\`.
   - Then propagate the choice into the spec via \`update_section\` — the document must reflect what was decided.`}
4. If a new choice surfaces while resolving another, capture it with \`create_decision\` rather than burying it in prose.
5. When *every* decision is resolved and the spec is coherent, move to build with \`update_doc("<memex>/${docTypePath(s.docType)}/${s.handle}", { status: "build" })\`. Only then do tasks come into play.`,
  },

  execute: {
    label: 'Execute ready tasks',
    description: 'Pick up an unblocked, not-started task and run with it. Only valid once the Spec is in `build`.',
    focus: (s) => {
      const isBuildOrLater =
        s.status === 'build' || s.status === 'verify' || s.status === 'implementation';
      if (!isBuildOrLater) {
        return `## How to start

⚠ **Wrong phase.** This Spec is in \`${s.status}\`, not \`build\`. Stop — switch to specify mode and resolve the ${s.openDecisions} open decision${s.openDecisions === 1 ? '' : 's'} first; only then is task work authorised.`;
      }
      return `## How to start

1. Call \`list_tasks("<memex>/${docTypePath(s.docType)}/${s.handle}", { readyOnly: true })\` — currently ${s.readyTasks} ready. Pick the top one (or ask if several are equally viable). Substitute the user's \`<namespace>/<memex>\` for \`<memex>\`.
2. **Search standards before writing code.** \`search_memex({ memex: "<namespace>/<memex>", query: "...", kind: 'standard' })\` for the domain or rule the task touches; read each match with \`get_doc(<standard-ref>)\`. **If nothing matches:** note the gap. Once the pattern stabilises, create the standard with \`create_doc({ memex, title, sections, docType: 'standard' })\` so the next agent inherits the rule — don't bake the choice silently into code.
3. **Read existing code first.** Use your coding tool's search (grep / ripgrep / editor symbol search) to see what the codebase already does in this area. The dominant source of agent rework is generating from scratch when an answer already exists in the repo.
4. Mark the task \`in_progress\` via \`update_task(<task-ref>, { status: "in_progress" })\`. Work in **small, verifiable steps** — change → type-check + tests → debug → continue. Don't accumulate untested diffs. **Stay watchful for standards drift mid-implementation** (it often surfaces as you read more code, not at the start). As acceptance criteria **actually pass**, tick them via \`update_task\`. If a rule looks wrong, or existing code diverges from one, surface it to the user and capture a decision rather than coding silently around it.
5. **Verify in the shape of the task** before marking \`complete\` — behavior changes need type-check + tests + exercising the new code path; refactors need tests passing + behavior unchanged; docs / config / UX need a contextual smoke check. Walk acceptance criteria against the running system, not the diff.
6. Move on to the next ready task. **If stuck:** decision in disguise → \`create_decision\` + \`update_task(<task-ref>, { addBlocker: "D-N" })\`; codebase question → read more code; unanswerable → \`add_comment\` with a \`question\`-typed comment. **If an approach is failing:** back out, re-read, surface as a decision.`;
    },
  },

  decisions: {
    label: 'Review open decisions',
    description: 'Walk through each open decision with the user and resolve them.',
    focus: (s) => `## How to start

1. Call \`get_doc("<memex>/${docTypePath(s.docType)}/${s.handle}")\` to load the current state and list the ${s.openDecisions} open decisions. Substitute the user's \`<namespace>/<memex>\` for \`<memex>\`.
2. Walk through them one at a time: present the title, context, and options — including any trade-offs you can infer from the document.
3. When the user decides, call \`resolve_decision(<decision-ref>, resolution)\` with a concise note capturing what was chosen and why. \`<decision-ref>\` is the doc ref plus \`/decisions/dec-N\`.
4. Continue until all open decisions are resolved or the user stops. If resolving a decision exposes a new unknown, create another decision with \`create_decision\` rather than glossing over it.`,
  },

  comments: {
    label: 'Review unresolved comments',
    description: 'Work through open comments, make the required changes, and resolve them.',
    focus: (s) => `## How to start

1. Call \`list_comments("<memex>/${docTypePath(s.docType)}/${s.handle}", { mode: 'review' })\` to get every section, decision, and task with open comments, each in full context. Substitute the user's \`<namespace>/<memex>\` for \`<memex>\`.
2. Walk through the ${s.unresolvedComments} unresolved comments one at a time: read the comment, discuss the intent with the user, and make the needed update (edit a section, resolve a decision, update a task, etc.).
3. When addressed, call \`update_comment(<comment-ref>, { status: 'resolved', resolution })\` with a note describing what was done. \`<comment-ref>\` is the doc ref plus \`/comments/c-N\`.
4. Continue until all unresolved comments are closed or the user redirects.`,
  },

  freeform: {
    label: 'Freeform',
    description: 'Load the current state and let the user say what to do.',
    focus: (s) => `## How to start

1. Call \`get_doc("<memex>/${docTypePath(s.docType)}/${s.handle}")\` to load the current state before taking any action. Substitute the user's \`<namespace>/<memex>\` for \`<memex>\`.
2. Based on the live state — especially open decisions, ready tasks, and unresolved comments — **ask the user what they would like to work on.** Offer options that match the status; do not assume.
3. As you progress, keep the document in sync: resolve decisions as they are made, update task status as work moves, create new tasks or decisions when scope emerges, and add comments when you need input.`,
  },
};

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Map a docType (as stored in the database) to the canonical ref path segment.
 * Specs live under \`specs/spec-N\`; free-form docs and execution-plans under
 * \`docs/doc-N\` / \`execution-plans/doc-N\`; standards under \`standards/std-N\`.
 */
function docTypePath(docType: string): string {
  switch (docType) {
    case 'spec':
      return 'specs';
    case 'standard':
      return 'standards';
    case 'execution_plan':
      return 'execution-plans';
    default:
      return 'docs';
  }
}
