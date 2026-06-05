# Init Prompt — teach this repo's CLAUDE.md to use Memex

## Your task

1. **Confirm the `memex` identifier for this repo.** It is a `<namespace>/<memex>` slug pair (e.g. `mindset-prod/memex-building-itself`).
   - First look for an existing pointer in `CLAUDE.md` or `README.md` (a `memex.ai/<ns>/<mx>` URL, or a prior Memex section).
   - If none, call `list_memexes()` and present the list — **do not auto-pick** the only or the personal one. Ask the user which Memex this repo maps to.
   - Record the chosen `<namespace>/<memex>` and use it verbatim in the examples you write into `CLAUDE.md`.

2. **Insert a section titled `## Working with Memex`** into `CLAUDE.md` (near the top, after any project overview). If a Memex section already exists, **merge/replace** it rather than duplicating. Use the canonical content in the next section, substituting the real `<namespace>/<memex>` into every example.

3. **Do not invent rules.** If you find the codebase contradicts anything below, flag it to the user — the Standard is probably right and the code has drifted (`flag_drift`), but surface it, don't silently "fix" the prose.

4. Leave everything else in `CLAUDE.md` untouched. Show the user the diff before considering the task done.

---

## Canonical content to write into CLAUDE.md

> Substitute the real `<namespace>/<memex>` you confirmed in step 1 for every occurrence of `<ns>/<mx>` below.

````markdown
## Working with Memex

This repo's work — Specs, Standards, decisions, and tasks — lives in the Memex workspace **`<ns>/<mx>`**. The Memex MCP server is the source of truth for that work; query it before claiming a fact about scope, decisions, or status.

### Using the Memex MCP server

**Orient before you act.** Memex is terse by default — pass `verbose: true` for full markdown, and call `get_information(topic='<slug>')` (or no args for the topic index) for operating depth the orientation omits.

| Step | Call |
|---|---|
| Discover workspaces | `list_memexes()` — present the list; never auto-pick |
| List active Specs | `list_docs({ memex: "<ns>/<mx>" })` (ACTIVE = plan/build/verify only) |
| Read one entity | `get_doc({ ref: "<ns>/<mx>/specs/spec-N" })` |
| Search everything | `search_memex({ memex: "<ns>/<mx>", query: "<topic>", kind: "standard" })` — semantic + FTS; `kind` ∈ `spec`/`standard`/`document`/`decision` |
| Fetch operating guidance | `get_information({ topic: "phases" })` |

**Two argument conventions, never mixed:**
- **Entity-acting tools** (`get_doc`, `update_task`, `add_comment`, `update_section`, …) take exactly one `ref` — the full canonical path. No `docId`/`taskId`/`sectionId`. 
- **Memex-scoped tools** (`list_docs`, `search_memex`, `create_doc`, …) take one `memex: "<ns>/<mx>"`.

**Chat is permissive; MCP is strict.** A human may type `spec-36`, `s36`, or "the spec we were on" — resolve it from context and build the canonical `ref` *before* the MCP call. The MCP boundary accepts only canonical refs (correct prefix, fixed case, no leading zeros).

**Two non-negotiable rules:**
1. **Tasks only exist in the `build` phase.** A task in draft/plan is a guess pretending to be a commitment — resolve decisions first.
2. **`complete` a task only when verification actually ran** (tests + type checks + exercising the path, not vibes). Closing a Spec (`done`) is the user's call, never the agent's.

Pipeline: `draft → plan → build → verify → done` (plus orthogonal `paused`/`archived`). Before any forward phase move, call `assess_spec({ mode: "phase", target: "<phase>" })` and walk its rubric.

### Reading a Memex URL

When someone pastes a Memex URL, strip the host to get the **canonical ref**, then feed it to an entity tool.

**URL / ref grammar:**
```
<HOST>/<namespace>/<memex>/<doc-type>/<doc-handle>(/<child-type>/<child-handle>)?
```

- **`<HOST>`** is path-based, never a subdomain: `memex.ai` (prod), `int.memex.ai` (staging), `localhost:5173` (dev). A tenant slug as a subdomain (`<ns>.memex.ai`) is invalid by design.
- **`<namespace>` / `<memex>`** — lowercase kebab (`[a-z][a-z0-9-]*`). Together they form the `memex` arg.
- **`<doc-type>` → `<doc-handle>`** (handle is type-bound):

  | doc-type | handle | entity |
  |---|---|---|
  | `specs` | `spec-N` | Spec |
  | `docs` | `doc-N` | free-form document |
  | `standards` | `std-N` | Standard |
  | `execution-plans` | `doc-N` | execution plan (shares the `doc-N` pool) |

- **`<child-type>` → `<child-handle>`** (optional, hangs off the doc):

  | child-type | handle |
  |---|---|
  | `sections` | `s-N` |
  | `decisions` | `dec-N` |
  | `tasks` | `t-N` |
  | `comments` | `c-N` |
  | `acs` | `ac-N` |
  | `issues` | `i-N` |

- **`N`** is a positive integer, **no leading zeros**. Handles are **case-strict**.

**Turning a pasted URL into a call** — drop the scheme + host, keep everything from `<namespace>` onward:

| Pasted URL | Canonical ref | Call |
|---|---|---|
| `https://memex.ai/<ns>/<mx>/specs/spec-36` | `<ns>/<mx>/specs/spec-36` | `get_doc({ ref: "<ns>/<mx>/specs/spec-36" })` |
| `https://memex.ai/<ns>/<mx>/standards/std-10` | `<ns>/<mx>/standards/std-10` | `get_doc({ ref: "<ns>/<mx>/standards/std-10" })` |
| `https://int.memex.ai/<ns>/<mx>/docs/doc-28/tasks/t-1` | `<ns>/<mx>/docs/doc-28/tasks/t-1` | `get_doc({ ref: "<ns>/<mx>/docs/doc-28/tasks/t-1" })` |

`get_doc` returns the whole document (its sections, decisions, tasks, comments) regardless of which child the URL pointed at — the child handle tells you *which part the human meant*. The MCP response always leads with `ref: <canonical-path>` and emits no UUIDs, so any identifier it returns can be passed straight back into the next call.

**References inside doc/comment bodies:** same-doc references use the bare child handle (`t-1`, `dec-3`, `s-2`); cross-doc references use the full canonical path.
````

---

## Acceptance check (do this before reporting done)

- [ ] `CLAUDE.md` has exactly one `## Working with Memex` section, with the real `<namespace>/<memex>` substituted into every example (no `<ns>/<mx>` placeholders left).
- [ ] Pick any Spec or Standard URL for this memex, strip it to a ref, and call `get_doc({ ref })` — confirm it resolves. This proves the grammar you wrote is correct for this workspace.
- [ ] You showed the user the diff and did not touch unrelated parts of `CLAUDE.md`.
