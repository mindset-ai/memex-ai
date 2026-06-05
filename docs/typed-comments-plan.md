# Typed Comments & Agent Feedback Loop — Implementation Plan

## Context & Motivation

Today the agent is instructed to "create an implementation plan first" before coding (`packages/server/src/agent/prompt-gen.ts:189`) and to write notes/questions back via `add_comment` (`:175`). But the prompt doesn't explicitly ask for:

- The plan to be posted back as a comment on the task
- Progress notes / observations during execution
- Issues / blockers encountered
- Deferred work (explicitly scoped out at runtime)
- Cross-task observations (things relevant to a *different* task in the same doc)
- Questions that need human input

All comments are also currently untyped — a human discussion comment and an agent plan dump render identically in the UI and in MCP output. The UI and the agent need a taxonomy so comments can be filtered, styled, and reasoned about.

This plan introduces:

1. A two-dimensional comment taxonomy: **source** (human/agent) + **type** (a small, closed set).
2. Schema + service + MCP + UI support for the taxonomy.
3. Updated agent prompting so the agent produces the right kinds of comments at the right moments.

---

## Proposed Taxonomy

### Source
Who wrote the comment.

- `human` — created by a logged-in user via the React UI.
- `agent` — created by any AI agent (in-app chat or MCP coding agent).

### Type
What kind of content the comment carries.

| Type            | Written by      | Purpose |
|-----------------|-----------------|---------|
| `discussion`    | human (default) | Freeform discussion, review feedback, questions to other humans. |
| `plan`          | agent           | Implementation plan posted at start of a task. One per task is expected. |
| `progress`      | agent           | Progress note / observation made while working. |
| `issue`         | agent or human  | Problem encountered, blocker, something unexpected in the code or data. |
| `deferred`      | agent           | Work the agent explicitly chose not to do (scope trim) — describes what was skipped and why. |
| `cross_task`    | agent           | Observation whose action lives on a *different* task. The comment is posted on that other task. Must reference the originating task (e.g. "From t-2 while implementing auth: …"). |
| `question`      | agent           | Question the agent needs a human to answer before it can continue. |
| `review`        | human           | Review feedback on agent work ("this isn't right, please redo X"). |

**Constraints:**
- Exactly one type per comment.
- `source` is derived server-side — clients do not set it directly. The React UI auth'd user writes → `human`; any MCP or server-tool-authored comment → `agent`.
- The agent is free to set `type`; if not provided, falls back to `discussion` with a warning.

---

## Current State (files touched by this plan)

- Schema: `packages/server/src/db/schema.ts:34` (`docComments` table).
- Service: `packages/server/src/services/comments.ts` (`addComment`, `addDecisionComment`, `addTaskComment`, `resolveComment`, `listCommentsForDoc`, `reviewDocComments`).
- MCP: `packages/server/src/mcp/tools.ts:221` (`add_comment`), `:248` (`list_comments`), `:273` (`list_doc_comments`), `:287` (`review_doc_comments`).
- MCP formatters: `packages/server/src/mcp/formatters.ts:98` (`formatComment`), `:111` (`formatDocComments`), `:159` (`formatReviewComments`).
- Agent prompt (in-app chat): `packages/server/src/agent/system-prompt.ts`, `packages/server/src/agent/tools.ts:225-238` (`add_comment` tool shape).
- Agent prompt (task code-gen prompt): `packages/server/src/agent/prompt-gen.ts` (the meta-prompt).
- Context builder: `packages/server/src/agent/context-builder.ts:67-94` (open comments rendering).
- React UI: `packages/admin/src/components/CommentTray.tsx`, `SectionCard.tsx`, `TaskPanel.tsx`, `DecisionPanel.tsx`.

---

## Schema Changes

Add two columns to `doc_comments`:

```ts
// packages/server/src/db/schema.ts
export const docComments = pgTable("doc_comments", {
  // … existing columns …
  source: text("source").notNull().default("human"),      // 'human' | 'agent'
  commentType: text("comment_type").notNull().default("discussion"),
  // …
});
```

Add a CHECK constraint for each new column to guard the allowed values (matching the `status` pattern used on `decisions` / `tasks`).

### Migration

- Drizzle-generated migration adds both columns with defaults.
- Backfill is implicit via the defaults (`source=human`, `commentType=discussion`) — every existing comment becomes a human discussion comment, which is correct.
- No data loss risk; columns are additive and NOT NULL with defaults.

Run: `pnpm --filter @memex/server db:generate` then `db:migrate`.

---

## Service Layer

### Types

Update the inferred `DocComment` type (it will pick up the new columns automatically) and add shared enums:

```ts
// packages/server/src/services/comments.ts (or a new types file)
export const COMMENT_SOURCES = ["human", "agent"] as const;
export const COMMENT_TYPES = [
  "discussion", "plan", "progress", "issue",
  "deferred", "cross_task", "question", "review",
] as const;
export type CommentSource = typeof COMMENT_SOURCES[number];
export type CommentType = typeof COMMENT_TYPES[number];
```

### Add functions

All three `add*Comment` functions take optional `source` and `commentType`:

```ts
export async function addTaskComment(
  taskId: string,
  authorName: string,
  content: string,
  opts?: { source?: CommentSource; commentType?: CommentType }
): Promise<DocComment> { … }
```

Call sites:
- MCP server tool `add_comment` → pass `source: "agent"`, `commentType: <from tool input>`.
- In-app agent tool `add_comment` → same.
- React UI REST handler → `source: "human"`, `commentType: <from request body, defaults to "discussion" or "review">`.

### New query helper

```ts
// Return per-task open comment counts broken down by type — used for badges + context.
export async function getTaskCommentBreakdown(
  docId: string
): Promise<Map<string, Record<CommentType, number>>>;
```

Keep `getCommentCountsForDoc` for overall counts; the breakdown helper is a richer variant the MCP/UI layers can use.

---

## MCP Tool Changes

### `add_comment` — now takes `type`

```ts
server.tool(
  "add_comment",
  "Add a comment to a section, decision, or task. Exactly one target ID. " +
  "Choose the comment type that matches what you're writing — see descriptions.",
  {
    sectionId: z.string().optional(),
    decisionId: z.string().optional(),
    taskId: z.string().optional(),
    authorName: z.string(),
    content: z.string(),
    type: z.enum(COMMENT_TYPES).describe(
      "plan: implementation plan at task start. " +
      "progress: note/observation during work. " +
      "issue: blocker or problem encountered. " +
      "deferred: work intentionally skipped (explain what + why). " +
      "cross_task: observation for a DIFFERENT task (post it on that task's id, mention the origin). " +
      "question: needs human input. " +
      "discussion: general discussion / default."
    ),
  },
  async ({ … type }) => {
    // force source = "agent" here
  }
);
```

### List / review output

Update `formatComment` to prepend a typed badge:

```
[AGENT · PLAN] **claude-code** (2026-04-16):
1. Migrate schema …
2. …
Comment ID: abc
```

Open-state bracket stays on a second line, or combine into `[AGENT · PLAN · OPEN]`. Pick one and apply everywhere.

Update `formatDocComments` and `formatReviewComments` to:
- Keep the grouping by target (section/decision/task).
- Optionally add per-type sub-grouping inside a target (e.g. "Plans (1)", "Issues (2)", "Questions (1)").

### New tools (optional but nice)

- `list_task_notes(taskId)` — convenience that returns only agent-authored comments on a task (plan/progress/issue/deferred/cross_task/question). Cuts the noise when the agent is reviewing its own history.
- `list_open_questions(docId)` — returns all `question`-typed open comments across the doc, so a human reviewer can triage what the agent is waiting on.

Leaning toward adding these because they're cheap and they match real agent workflows better than forcing the agent to filter a generic list.

### `formatTask` badge update

Today the badge shows `[N open, M resolved comments]`. Extend (or replace) with type-aware counts when they're informative:

```
- t-1 [READY]: "Database Schema" [plan · 2 progress · 1 question]
```

Only show types with non-zero counts.

---

## Agent Prompt Changes

### In-app system prompt (`system-prompt.ts`)

Add a "Comment conventions" section listing the types and when to use each. Keep it short — the agent is mostly talking, not coding, in this context. The main update: distinguish `discussion` (default for chat) from `question` / `issue` / `review`.

### Task code-gen meta-prompt (`prompt-gen.ts`)

This is the bigger change — the meta-prompt currently produces a task-scoped implementation prompt. Update the **output** prompt so the coding agent is explicitly told to:

1. **Before coding:** call `add_comment(taskId, type=plan, content=<your plan>)` with its implementation plan. The plan lives on the task so future agents can see it. (Right now step 7 of the meta-prompt says "create an implementation plan first" but doesn't say where to put it.)
2. **During coding:**
   - `type=progress` for meaningful observations (not every file edit — think "aha" moments, trade-offs chosen, unexpected coupling discovered).
   - `type=issue` for anything that blocks or surprises.
   - `type=deferred` when intentionally skipping something — **include what was skipped and the reason**, so a follow-up task can be created from it.
   - `type=cross_task` when touching code reveals work that belongs to another task — post the comment on *that* task's ID, not the current one. Include `"From t-N: …"` as a prefix so the origin is clear.
   - `type=question` when it needs a human decision mid-flight. The agent should then stop and wait, not guess.
3. **When finishing:**
   - Post a `type=progress` closing note summarising what shipped (different from the commit message — the comment lives on the task, the commit lives in git).
   - Set `update_task_status(complete)`.
4. **Not:** use `type=discussion` — that's reserved for human-authored conversation.

The meta-prompt's "Available MCP tools" section (around `prompt-gen.ts:173`) needs to be rewritten to reflect the typed tool and list the types with one-line guidance.

### Context builder (in-app agent)

`context-builder.ts:67-94` lists "Open Comments" — include the `source` and `type` inline:

```
### On task: t-1 — Database Schema (id: …)
- [AGENT · plan] (claude-code): 1. Create migration …
- [HUMAN · review] (alice): Please add an index on docId
```

This lets the chat agent see *what kind* of follow-up is needed without rereading each comment's full content.

---

## Web UI Changes (`packages/admin/`)

### Visual language

- **Source** → avatar / border style:
  - `human` → user initials avatar, neutral border.
  - `agent` → robot icon, accent border (e.g. left border in `indigo-500`).
- **Type** → small coloured pill next to the author name:
  - `plan` → indigo, `progress` → slate, `issue` → amber, `deferred` → zinc, `cross_task` → purple, `question` → red, `review` → blue, `discussion` → ghost/gray.

Use status-badge utilities already in `packages/admin/src/utils/statusStyles.ts` — extend that map rather than adding styling ad hoc.

### Components

- **`CommentTray.tsx`** — add a type filter chip row at the top (`All · Plan · Progress · Issues · Questions · Deferred · Discussion`). Persist the last-used filter per target in local state.
- **Comment composer** — when a human writes a comment, default `type=discussion`; expose a small dropdown for `review` / `issue` / `question` (humans don't write `plan` / `progress` / `deferred` / `cross_task`). Agent-only types are hidden from the dropdown.
- **`TaskPanel.tsx`** — add a compact badge strip on each task line: `[plan ✓] [3 progress] [1 question] [1 deferred]`. Clicking a badge opens the comment tray filtered to that type.
- **`SectionCard.tsx` / `DecisionPanel.tsx`** — show the type pill on each comment; add the same filter row in the comment tray, but with fewer options (sections/decisions mostly see `discussion` / `review` / `question` / `issue`).

### API types

Extend `packages/admin/src/api/types.ts` with `source` and `commentType` on `Comment`. Update the REST client accordingly.

### Open-questions inbox (optional, nice to have)

A new route `/questions` that lists all open `question` comments across all docs — surfaces what the agents are waiting on. Backed by the `list_open_questions` MCP/REST endpoint. Skip if scope pressure; call out as phase 2.

---

## Rollout Order

1. **Schema + service** (PR 1)
   - Migration adds columns with defaults.
   - Service functions accept `source` / `commentType`.
   - Existing callers default to `source=human, type=discussion`.
   - No behaviour change visible yet.

2. **MCP tool surface** (PR 2)
   - `add_comment` accepts `type`.
   - `list_*` / `review_*` output includes the type/source in `formatComment`.
   - `formatTask` badge reflects typed counts.
   - Optional: `list_task_notes`, `list_open_questions`.

3. **Agent prompts** (PR 3)
   - `prompt-gen.ts` meta-prompt updated.
   - `system-prompt.ts` gets the taxonomy section.
   - `context-builder.ts` surfaces source + type inline.

4. **React UI** (PR 4)
   - Type pills + filter chips + typed composer.
   - `TaskPanel` badge strip.
   - API types extended.

5. **Docs + onboarding** (PR 5)
   - Update `docs/agentic-interface-spec.md` with the taxonomy.
   - Update any public API docs (the `POST /api/comments/*` endpoints).

Each PR should be independently deployable; later phases degrade gracefully if an earlier one hasn't shipped (since everything defaults to `human`/`discussion`).

---

## Testing

### Unit
- `formatComment` renders typed badge for each (source, type) permutation.
- `formatTask` badge shows only non-zero typed counts.
- Comment composer defaults vary by caller (MCP vs REST handler).

### Integration (needs DB)
- `addTaskComment` with each `commentType` persists and round-trips.
- CHECK constraint rejects invalid `source` / `commentType`.
- `listCommentsForDoc` groups by target and surfaces source+type.
- `getTaskCommentBreakdown` returns correct per-type counts.

### API / E2E
- `POST /api/comments/task/:id` from admin → `source=human`.
- MCP `add_comment` via `/mcp` → `source=agent`.
- A `question`-typed comment on a task shows up in `list_open_questions`.

### UI
- Vitest: filter chips filter the rendered list.
- Vitest: the composer does not offer agent-only types to humans.

---

## Open Questions (need your input before execution)

1. **Taxonomy scope.** Does the 8-type list above match how you think about it? Anything missing (e.g. `insight`, `risk`, `todo`)? Anything redundant (e.g. collapse `deferred` into `issue`)?
2. **`cross_task` semantics.** Is it better to model this as a first-class *link* (a `cross_task` comment with an explicit `originTaskId` column) instead of encoding the origin in prose? More structure but more work.
3. **Auto-create tasks from `deferred`?** Should a `deferred` comment optionally spawn a new task (status `not_started`, blocked by nothing)? Or strictly stay as a note until a human promotes it?
4. **Type on section/decision comments.** The taxonomy was designed with tasks in mind. On sections and decisions, only `discussion` / `review` / `question` / `issue` really apply. Do we:
   - (a) allow all types everywhere and trust the agent to pick appropriately, or
   - (b) constrain the allowed set per target (more UI logic, clearer semantics)?
5. **Source immutability.** Should `source` ever be editable after creation (e.g. an admin flagging an agent comment as actually-from-a-human)? Default assumption: no.
6. **Resolution UX for `question`.** When a human answers a `question` comment, we mark it resolved with the answer. Should the agent be *notified* (e.g. on next chat turn) that a question it raised was answered? Requires a notification surface we don't have yet.
7. **Existing `review_doc_comments` tool.** Right now it returns open comments of all types. Do we (a) keep it general, (b) split into per-type reviewers, or (c) default to hiding `progress` (usually noise for a human reviewer) unless a flag is passed?
8. **Migration visibility.** All existing comments become `(human, discussion)` by default. Want to inspect them before the migration and hand-tag any obvious agent-written ones, or accept the default?
9. **Badge format on `formatTask`.** Current: `[3 open, 1 resolved comments]`. Proposed: `[plan · 2 progress · 1 question]`. Lose the resolved count, or keep both (gets long)?

Answer 1, 2, 4, and 9 and the plan is executable end-to-end. The rest are refinements that can be settled during the relevant PR.
