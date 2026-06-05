import type { DocWithGraph, Task, Decision, Comment } from '../api/types';
import { MEMEX_MCP_TOOLS_REFERENCE } from './specInitPrompt';

/**
 * Generates the per-task "Init Prompt" — a self-contained briefing pasted into
 * a fresh coding-agent session so it can immediately pick up a single task.
 *
 * Mirrors `renderSpecInitPrompt` (spec "Spec Coding Agent") in shape: a
 * static template assembled from named fragments. No LLM round-trip — these
 * prompts are deterministic and fast.
 *
 * The agent is told to:
 *   1. Read the parent spec (`get_doc`) to understand the why and the shape.
 *   2. Review **resolved** decisions — they are the constraints the Org
 *      already settled. Then check **open** decisions for blockers.
 *   3. Read comments on the task (review / plan_revision / readiness_check).
 *   4. Mark in_progress, do the work, tick acceptance criteria, mark complete.
 */
export function renderTaskInitPrompt(
  doc: DocWithGraph,
  task: Task,
  taskComments: Comment[] = [],
): string {
  const decisions = doc.decisions ?? [];
  return [
    INTRO(doc, task),
    TASK_DETAIL(task),
    DECISIONS_SUMMARY(decisions, task),
    TASK_COMMENTS_SUMMARY(taskComments),
    HOW_TO_START(doc, task),
    MEMEX_MCP_TOOLS_REFERENCE,
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim() + '\n';
}

// ── Editable prompt fragments ─────────────────────────────────────────────

const INTRO = (doc: DocWithGraph, task: Task) => {
  const isBuildOrLater =
    doc.status === 'build' || doc.status === 'verify' || doc.status === 'implementation';
  const phaseGate = isBuildOrLater
    ? ''
    : `

> ⚠ **Wrong phase.** This Spec is in \`${doc.status}\`, not \`build\`. Tasks are not yet authorised to be worked on. Switch to a planning conversation, resolve the open decisions, and publish the Spec to \`build\` before picking up this task.
`;

  return `You are picking up a single task on the memex **${doc.docType}** *${doc.title}*.

- **Spec:** ${doc.title} (\`${doc.handle}\`) — status: \`${doc.status}\`
- **Task:** T-${task.seq} — ${task.title}
- **Status:** ${task.status}${task.blocked ? ' (blocked)' : ''}
${phaseGate}
Memex is the **governance layer and system of record** — it tells you what to do, constrains how based on decisions and standards, and catches the output of your work. Your inner coding loop (read existing code first, make small changes, test as you go, debug instead of guessing, back out cleanly when an approach is dead) is yours, not Memex's. Read the document, respect the decisions, and use the MCP server (below) to call back into Memex as you go — log progress, tick acceptance criteria, surface new decisions if you hit one. Don't shadow it in chat or local notes.`;
};

const TASK_DETAIL = (task: Task) => {
  const lines: string[] = [`## Task T-${task.seq}: ${task.title}`, '', task.description.trim() || '_(no description)_'];

  if (task.sectionRef) {
    lines.push('', `**Anchored to section:** \`${task.sectionRef}\``);
  }

  if (task.acceptanceCriteria.length > 0) {
    lines.push('', '**Acceptance criteria:**');
    for (const ac of task.acceptanceCriteria) {
      lines.push(`- [${ac.done ? 'x' : ' '}] ${ac.description}`);
    }
  }

  if (task.blocked) {
    const decBlockers = task.blockedByDecisions.map((d) => `D-${d.seq} (${d.title})`);
    const taskBlockers = task.blockedByTasks.map((t) => `T-${t.seq} (${t.title})`);
    const all = [...decBlockers, ...taskBlockers];
    lines.push(
      '',
      `> **Blocked by:** ${all.join(', ')}`,
      `> Resolve the blockers (or get them resolved) before doing the work — don't paper over them.`,
    );
  }

  return lines.join('\n');
};

const DECISIONS_SUMMARY = (decisions: Decision[], task: Task) => {
  if (decisions.length === 0) {
    return `## Decisions on this spec

No decisions have been recorded yet. If you discover a real choice while working, capture it with \`create_decision\` rather than burying it in code.`;
  }

  const resolved = decisions.filter((d) => d.status === 'resolved');
  const open = decisions.filter((d) => d.status === 'open');
  const blockingIds = new Set(task.blockedByDecisions.map((d) => d.id));

  const lines: string[] = ['## Decisions on this spec', ''];

  if (resolved.length > 0) {
    lines.push(
      '**Resolved (these are settled — your work must respect them):**',
    );
    for (const d of resolved) {
      const resolution = d.resolution?.trim();
      const tail = resolution ? ` → ${truncate(resolution, 200)}` : '';
      lines.push(`- \`D-${d.seq}\` ${d.title}${tail}`);
    }
    lines.push('');
  }

  if (open.length > 0) {
    lines.push('**Open (still up for grabs):**');
    for (const d of open) {
      const blocks = blockingIds.has(d.id) ? ' — **blocks this task**' : '';
      lines.push(`- \`D-${d.seq}\` ${d.title}${blocks}`);
    }
    lines.push(
      '',
      `Before you start, confirm none of the open decisions block this task. If one does, **stop** and either resolve it (with the user) or report back — don't guess your way through.`,
    );
  }

  return lines.join('\n').trimEnd();
};

const TASK_COMMENTS_SUMMARY = (comments: Comment[]) => {
  if (comments.length === 0) return '';

  const open = comments.filter((c) => !c.resolvedAt);
  if (open.length === 0) return '';

  const byType = new Map<string, Comment[]>();
  for (const c of open) {
    const t = c.commentType ?? 'discussion';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(c);
  }

  const priority = ['plan_revision', 'review', 'readiness_check', 'issue', 'question', 'discussion'];
  const ordered = [...byType.entries()].sort(([a], [b]) => {
    const ai = priority.indexOf(a);
    const bi = priority.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const lines: string[] = [
    '## Open comments on this task',
    '',
    `${open.length} unresolved comment${open.length === 1 ? '' : 's'} on this task. Read these before you start — \`plan_revision\` and \`review\` comments capture explicit human feedback you must address.`,
    '',
  ];

  for (const [type, items] of ordered) {
    lines.push(`**${type} (${items.length}):**`);
    for (const c of items) {
      lines.push(`- ${c.authorName}: ${truncate(c.content, 240)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
};

const HOW_TO_START = (doc: DocWithGraph, task: Task) => {
  const docPath = `<memex>/${docTypePath(doc.docType)}/${doc.handle}`;
  const taskRef = `${docPath}/tasks/t-${task.seq}`;
  return `## How to start

1. Call \`list_memexes()\` to confirm the workspace, then \`get_doc("${docPath}")\` and read the sections in order. Memex documents are an argument for how the work should go — don't skim them. Substitute the user's \`<namespace>/<memex>\` for \`<memex>\` in every \`ref\`.
2. Walk the resolved decisions one by one (listed above) and confirm you understand each constraint. Treat each \`resolution\` as a directive, not advice.
3. Check the open decisions for blockers on this task. If any block it, **stop** and report — don't proceed.
4. Read every open comment on this task: \`list_comments("${taskRef}")\`. Apply any \`plan_revision\` / \`review\` direction before writing code.
5. **Search applicable standards (and prior decisions / specs).** Call \`search_memex({ memex: "<namespace>/<memex>", query: "...", kind: 'standard' })\` for the domain or specific rule this task touches; read each match with \`get_doc(<standard-ref>)\`. Standards encode invariants your code must respect. You can also drop the \`kind\` arg to surface related Specs and Decisions in the same call. **If nothing matches:** note the gap. Once the pattern stabilises, create the standard with \`create_doc({ memex, title, sections, docType: 'standard' })\` so the next agent inherits the rule — don't bake the choice silently into code. (Standards verbs for flagging drift or proposing a change to an *existing* rule are temporarily disabled — if a rule is wrong or code diverges from one, surface it to the user and capture a decision; \`create_doc(... docType:'standard')\` is the one for "no rule exists yet.")
6. **Read existing code before writing new code.** Use your coding tool's search (grep / ripgrep / editor symbol search) to see what the codebase already does in this area. The dominant source of agent rework is generating from scratch when an answer already exists.
7. Mark the task in progress: \`update_task("${taskRef}", { status: "in_progress" })\`. Then do the work in **small, verifiable steps** — make a change, run the type check + relevant tests, debug if anything broke, continue. Don't accumulate large untested diffs. **Stay watchful for standards drift mid-implementation** — it often surfaces as you read more code, not at the start.
8. While implementing:
   - Tick acceptance criteria via \`update_task("${taskRef}", { acceptanceCriteria: [...] })\` as each one **actually passes** — not before.
   - **Stay watchful for standards drift.** If existing code diverges from a standard, or a rule itself looks wrong or stale, surface it to the user and capture a decision — don't silently code around it. (Tools for flagging drift / proposing a rule change are temporarily disabled.)
   - If a real choice surfaces, file it with \`create_decision(<doc-ref>, ...)\` and \`update_task("${taskRef}", { addBlocker: "D-N" })\` — never guess.
9. **Verify in the shape of this task before declaring done.** What "verified" means depends on what changed:
   - **Behavior change (feature, bugfix):** type checks pass with zero errors; the test suite passes; the new code path is exercised by a test or integration check; nothing downstream is visibly broken.
   - **Refactor (no intended behavior change):** type checks pass; test suite passes; observable behavior unchanged (spot-check or run the affected end-to-end path).
   - **Docs / config / copy:** read the change in context; run any relevant linter / formatter / build; exercise the affected path if there's an obvious one.
   - **UX / visual:** open the affected screen; check it renders; if interactive, click it.

   Always: walk each acceptance criterion against the running system, not against the diff. Then: \`update_task("${taskRef}", { status: "complete" })\` and resolve any task comments you addressed with \`update_comment(<comment-ref>, { status: 'resolved' })\`.

## When something goes sideways

**Stuck on how to do this.** Surface — don't fake forward motion. Three patterns:
- **Stuck on a design choice?** That's a decision in disguise. Capture it with \`create_decision(<doc-ref>, ...)\`, link it as a blocker with \`update_task("${taskRef}", { addBlocker: "D-N" })\`, and stop.
- **Stuck on "how does this codebase do X?"** Read more. Your coding tool's search (grep / ripgrep / editor symbol search) first; generation last.
- **Stuck on something the codebase can't answer?** Add a \`question\`-typed comment via \`add_comment("${taskRef}", ...)\` naming what you don't know, and surface to the user. Don't grind for an hour producing plausible-looking code.

**Failing approach.** If tests still don't pass after multiple attempts, or each fix breaks two more things, the approach is wrong. **Back out** — revert your changes. **Re-read** the Spec narrative + the relevant standards; the failure usually surfaces a constraint you missed. **Then surface** as a decision if the right approach is now genuinely unclear.`;
};

// Map a docType to the canonical ref path segment. Specs → `specs`;
// standards → `standards`; execution_plan → `execution-plans`; everything
// else → `docs`. Mirrors the helper of the same name in specInitPrompt.ts —
// kept local to avoid a cross-file import for a 6-line fn.
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

function truncate(s: string, max: number): string {
  const trimmed = s.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
}
