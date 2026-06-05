# Agent prompting + tool-access audit checklist

This is the standing checklist for keeping the **React UI agent** (chat
panel) and the **MCP server** (Claude Code, Claude Desktop, etc.) in
sync. Run it whenever you:

- add a new server-side tool, or change an existing one,
- add a new document type or change docType semantics,
- add or remove an interactive UI tool,
- change the system prompt, the spec-document skill, or any
  agent-facing text that the user cannot see.

The goal is simple: **every workflow a user can do via Claude Code on
their CLI should also work in the React UI chat panel, and vice versa.**
Whenever the two surfaces drift, users discover it the hard way.

Scope today (per dec-4 of doc-14): **Spec, Standard, Document,
Execution plan.** The React UI agent runs the *same* tool surface as
MCP — the only legitimate single-surface entries are `list_memexes`
(the UI agent is already memex-scoped via session) and a small set of
read-only introspection tools whose data the UI agent already gets via
injected system-prompt context.

---

## 0. The doc-14 catalogue (single source of truth)

The MCP tool surface was consolidated from 62 → ~32 tools in doc-14.
The new surface (`packages/server/src/mcp/tools.ts`):

- **Workspace:** `list_memexes`
- **Documents (generic across docType):** `list_docs`, `get_doc`,
  `create_doc`, `update_doc`, `add_section`, `update_section`
- **Decisions:** `create_decision`, `update_decision`,
  `resolve_decision`, `approve_candidate`, `reject_candidate`
- **Tasks:** `list_tasks`, `create_task`, `update_task`, `delete_task`
- **Comments:** `add_comment`, `list_comments`, `update_comment`
- **Spec lifecycle:** `assess_spec`, `publish_spec`
- **Standards workflow:** `flag_drift`, `propose_standard_change`
- **Memex-wide search:** `search_memex` (covers Specs, Standards, free-form
  docs, and Decisions; pass `kind: 'standard'` for the old standards-only
  behaviour)
- **Codebase intelligence:** `list_repos`, `get_repo`, `update_repo`,
  `list_symbols`, `get_symbol`, `get_file`, `code_search`

**Migration policy (per dec-5 of doc-14):** removed tools return a
structured error pointing at the replacement. The single source of
truth for the cut/keep/rename mapping is
`packages/server/src/mcp/migration-map.ts`. **No silent breakage; no
permanent aliases.** When the request handler in `app.ts` sees an
unknown tool name, it consults that map and surfaces the migration
note to the client.

If you add or remove a tool, both `mcp/tools.ts` *and* (when removing)
`mcp/migration-map.ts` must be updated, and the parity gate in
`packages/server/src/__regression__/tools-coverage.regression.test.ts`
should pass without manually whitelisting the change.

---

## 1. Tool inventory — record both surfaces

Run this command in a clean checkout:

```bash
pnpm --filter @memex/server exec vitest run \
  src/__regression__/tools-coverage.regression.test.ts
```

That test will fail loudly if a tool exists on one surface but not the
other (outside the explicit `MCP_ONLY` whitelist). It also asserts
that every name in `migration-map.ts` is absent from both surfaces, so
removed tools cannot silently come back. If you intentionally want a
single-surface tool, update the whitelist **and explain why in a
comment** in the test file.

### Intentionally MCP-only (and why)

- **`list_memexes`** — the React UI agent is already memex-scoped via
  the user's session. It has no need to enumerate memexes; the host
  already pinned one before the chat opened.
- **`list_docs`** — read-only introspection. The React UI agent
  receives the relevant doc state via system-prompt context for the
  doc the user is currently viewing; cross-doc listing isn't part of
  its loop today. MCP clients lack that injection and need an explicit
  way to enumerate.
- **`get_doc`** — same rationale as `list_docs`. The React UI agent
  has the *current* doc fully expanded in its context window already,
  so re-fetching it via a tool would be wasted budget. MCP clients
  need it as their only read path.
- **`list_tasks`** — same rationale: full task state for the current
  doc is already in the UI agent's context. MCP clients lack the
  injection and need explicit listing (incl. `readyOnly:true`).
- **`list_comments`** — same rationale: comments for the current doc
  are already in the UI agent's context.

These are intentional, defensible exclusions, not gaps. Everything
else (mutations + cross-cutting workflows) lives on both surfaces.

### Agent-only (UI tools, by design)

UI tools pause the agent loop and await a user click — they have no
meaning in the MCP context. These live in
`packages/server/src/agent/tools.ts` only:

- `render_action_buttons`, `render_choices`, `render_confirmation`,
  `render_progress`, `render_callout`, `render_steps`

---

## 2. Tool description accuracy

For every tool in the catalogue, the **description visible to the
LLM** must:

- Match actual API behavior (don't promise inputs/outputs the handler
  doesn't deliver).
- Surface DB-level constraints that aren't obvious from the schema —
  e.g. `add_section`'s `(docId, sectionType)` uniqueness rule, the
  immutability of `documents.handle`.
- For mutation tools, include "Returns the full document state" or the
  equivalent so the agent knows what to do with the result.
- For agent ↔ MCP duplicates, the descriptions don't need to be
  byte-identical, but they must convey the same constraints. If MCP
  says "X must be unique" the agent description must too — don't let
  one side drift into a "trial-and-error" workflow.

Spot-check after a tool change:

```bash
pnpm --filter @memex/server exec vitest run src/mcp/tools.test.ts \
  src/agent/system-prompt.test.ts
```

Both files include description-content snapshots.

---

## 3. System prompt review

Read `packages/server/src/agent/system-prompt.ts` end-to-end after any
change and confirm coverage of:

- **Document types** — Spec + Standard + Document defined; legacy
  `strategy` / `mission` / `brief` / `blueprint` references should not appear.
- **Document Manipulation Guidelines** — rename intents map to
  `update_doc({ docId, title })`, NEVER `update_section` on the
  Overview body.
- **Confirm-only-after-success** rule for any tool call.
- **Creation Workflow** — Overview-only by default (dec-1 Option A
  from doc-5). The modal closes after `create_doc`; further sections
  are added from inside the Spec's chat panel.
- **Spec Document skill** loaded as the second prompt block (cache
  breakpoint) and aligned with the workflow above.
- **Codebase intelligence section** uses the new tool names: `get_repo`,
  `list_symbols`, `get_symbol({ include: ['calls'|'dependencies'|'impact'] })`,
  `get_file`, `code_search`.

If you change creation-phase behavior, also re-read
`packages/server/src/agent/skills/spec-document.md` so the skill
agrees with the system prompt — they're loaded together.

---

## 4. Gap analysis (rolling)

Open gaps that future audits should pick up:

- **No regression test on description-content cross-checks.** The
  current test asserts existence parity. A future hardening would
  assert that for the same tool name, both surfaces' descriptions
  contain the same DB-constraint phrases (e.g. "unique within the
  document", "immutable handle").
- **Per-doctype tool gating.** `create_doc` and friends accept any
  `docType`. If we ever want type-restricted tooling (e.g. forbid
  decisions/tasks on Documents), the audit should add a
  "tool-vs-doctype" matrix.

When you close one of these, delete the bullet.

---

## 5. New-tool checklist

Before merging a PR that adds, removes, or renames a tool:

1. [ ] Tool is registered in BOTH `packages/server/src/mcp/tools.ts`
       (via `server.tool(...)`) and `packages/server/src/agent/tools.ts`
       (via the `serverTools` array + an executor case), unless it
       falls into the documented MCP-only set above.
2. [ ] If the tool is single-surface, the corresponding whitelist
       (`MCP_ONLY` in `tools-coverage.regression.test.ts`) is updated
       with a comment explaining why.
3. [ ] If the change *removes* a tool, an entry is added to
       `packages/server/src/mcp/migration-map.ts` pointing at the
       replacement and explaining how to call it. Removed names must
       NOT come back on either surface — the parity gate enforces this.
4. [ ] Description spells out any DB-level uniqueness constraints,
       immutability rules, or required ordering invariants.
5. [ ] If the tool is a mutation, the agent prompt mentions it under
       "Document Manipulation Guidelines" (or extend that section).
6. [ ] Snapshot tests in `mcp/tools.test.ts` and / or
       `agent/system-prompt.test.ts` are updated.
7. [ ] `pnpm --filter @memex/server exec vitest run src/__regression__`
       passes.
8. [ ] `pnpm --filter @memex/server exec vitest run` (full server suite)
       passes — not just the regression directory.

If the tool is a NEW document type or changes existing docType
semantics, also update:

- `agent/system-prompt.ts` — Document types section.
- `agent/skills/spec-document.md` — Spec vs Standard vs Document
  distinction.
- `docs/agent-audit-checklist.md` (this file) — scope statement at the
  top.
