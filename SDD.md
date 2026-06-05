# Spec-Driven Development

## What it is, in one breath

**Spec-Driven Development** is the position that the durable unit of software work is the *living spec* — a continuously-reconciled record of purpose, decisions, acceptance criteria, and tasks that the system itself enforces, that survives the work, and that both humans and AI agents collaborate against as the contract between intent and shipped code.

You work *against* a spec; the spec doesn't get written *after* the work. And the spec isn't a file — it's a node in a knowledge map.

## Drift is the failure mode

Every prior generation of "be more rigorous about specs" has failed for the same reason: **drift.** The spec and the code start aligned; the code moves; the spec doesn't; the gap widens; the spec becomes wrong; the code becomes the only source of truth that anyone trusts; the spec is quietly retired.

Drift is the *named enemy* of SDD. Everything else — typed primitives, phase discipline, the knowledge map, the two surfaces — exists to detect drift, surface it, and force a reconciliation before the gap compounds.

AI agents make drift worse, not better. Work no longer flows linearly from one developer; it flows in parallel from features, bug fixes, refactors, and multi-step agent runs. Each agent step can compound a small misalignment into a large one — the agent reads a stale spec, makes a locally-correct decision against the wrong premise, and ships code that satisfies its task while violating the architectural intent. A study of 600 rejected AI-generated PRs found that *alignment loss during execution* caused more failures than incorrect task descriptions. The task was understood; the spec the task referenced had already drifted.

## The static-spec catalogue

Every artifact in this catalogue fails the same way: nothing checks it against the code.

- **PRDs** get written by product, approved, frozen, never touched. Within two weeks engineering ships something else and the PRD becomes a museum piece.
- **MRDs** describe the market at a moment in time. The market moves; the MRD doesn't.
- **Design docs and RFCs in a wiki** drift the moment the code changes. The wiki has no idea what the code is doing.
- **MD files in the repo** (`ARCHITECTURE.md`, `docs/spec.md`, the `CLAUDE.md` your agent reads) are at least co-located with the code, but they're prose nobody enforces. CI doesn't fail when the file disagrees with the implementation. The acceptance-criteria checklist in an MD file is a checklist nobody walks.
- **MD files passed around in chat** — Notion pages, Google Docs, dropped attachments — are the worst: no canonical location, no version, no enforcement, no link to anything. Read once, then dead.

The common failure: **a static spec has no mechanism by which it stays in agreement with reality.** It's advisory at best. By the time someone reads it again, the spec is wrong and the code is the source of truth — the exact inversion the spec was meant to prevent.

## Living specs

A living spec is one where the system itself keeps the spec true. Five properties make it living:

- **Acceptance criteria are typed primitives, not prose checkboxes.** The system knows what each AC is, knows whether it's been verified, and gates `done` on per-AC verdicts. "The spec promised X but we shipped Y" is detectable, not buried in prose.
- **Verification runs continuously as part of the testing process.** ACs are walked against running behaviour at every phase transition, every test run, every drift-check. A failing AC reopens the spec; the spec is never frozen enough to ignore.
- **Decisions are typed and tracked.** "We picked Option B because X" is a resolved decision with status, options, and lineage preserved — not a sentence in a doc. Future code that contradicts a resolved decision is detectable by traversal.
- **The narrative is consolidated, not appended.** The spec isn't a chronological log — it's continuously re-synthesised so the current text of the spec is the current intent of the team.
- **The spec is queryable, not just readable.** Semantic + full-text search across every spec, every decision, every standard. You reach the spec by *what it's about*, not by knowing where the file lives.

The static spec dies because nothing checks it. The living spec stays alive because the system checks it — typed primitives, enforced phases, per-AC verification, real-time change stream. Every claim in the spec has a corresponding mechanism that keeps it honest.

## The maturity ladder

The industry is converging on this loosely:

- **L1 — Spec-First.** Spec authored before code; manual reconciliation; one-way traceability (spec → code). Examples: Amazon Kiro, GitHub Spec Kit. The spec is more rigorous than a PRD but still drifts the moment implementation begins.
- **L2 — Spec-Anchored.** Continuous bidirectional reconciliation: the spec informs code, and code changes flow back to update the spec. Durable sessions, shared memory, reconciliation checkpoints between agent steps. Example: Augment Cosmos.
- **L3 — Spec-as-Source.** The spec is the primary edit surface; code is generated (and regenerated) from it. Example: Tessl.

Memex's position on this ladder is **past L1 in structure, building toward L2 in mechanism, with one structural bet that none of L1–L3 have made:** the spec is not a single document being reconciled with code — it's a *node in a knowledge map* that's being reconciled with code *and* with sibling specs *and* with cross-cutting standards *and* with prior decisions. Single-spec bidirectional sync is the table stakes. Multi-axis reconciliation across a typed graph is what makes a knowledge-map spec stronger than a Cosmos-style spec.

## Memex is a knowledge map, not a document store

A **document store** treats specs like files — you put them in, you take them out, you read them top to bottom. The unit of retrieval is the document. Relationships between documents live in your head or in hyperlinks you maintain by hand. Wikis, Notion, Google Drive, `/docs` folders — all document stores. They scale linearly with reader attention; nothing in the system reasons about the contents.

A **knowledge map** treats specs as nodes in a graph:

- **Specs** link to the decisions they resolved, the standards they obey or violate, the prior specs they descend from, the source code they promised to change.
- **Decisions** link to the code that depends on them and to other decisions that branch off them.
- **Standards** link to every spec and decision that cites them — when a standard moves, every dependent claim surfaces.
- **Acceptance criteria** link to the tasks that close them and the verification evidence that proves them.

You don't navigate the knowledge map by filename. You navigate by *relationship* and by *semantic search*. The unit of retrieval is the relevant fact, not the document. "Search Memex first" is not a productivity tip — it's a structural requirement, because the knowledge map only does its job if both the agent and the human treat it as the source of truth.

## Two drift scenarios from this codebase

Abstract claims about drift are cheap. Two concrete examples from the memex-app repo:

**1. Standard-to-code drift (caught only by human review).** Standard **std-8** says every tenancy-scoped mutation must flow through `mutate()` in `packages/server/src/services/mutate.ts` — including silent mutations, so the unified bus stays coherent. The b-21 architectural review found that token-lifecycle services (`auth-tokens.ts`, `cli-auth.ts`, `invite-tokens.ts`) bypass `mutate()` and write directly to the DB. The Standard didn't change; the code drifted. No CI check caught it. No regression test asserted it. It surfaced only because a human ran an architectural review and noticed. In a knowledge-map model, "every cite of std-8 must match every mutating service" is a traversal the system could run continuously — not a finding that waits for a human audit quarter.

**2. Intra-Memex drift (the agent invents primitives the schema doesn't have).** The plan-phase prompt (`packages/server/src/agent/phases/plan/transitions.md:13`) tells the agent to check that "the Brief's Acceptance Criteria section reads as outcomes, not implementation steps." The brief-document skill (`brief-document.md:38`) describes ACs as a Brief-level section. But the **schema** only knows about task-level ACs — JSONB on the `tasks` table (`packages/server/src/db/schema.ts:279`). The prompts ask for one shape; the primitives only support another. When an agent tries to honour the prompt, it improvises: ACs as prose in decision resolutions, ACs in narrative sections, ACs attached to placeholder tasks. None of those are wrong; none of them are typed. This is drift *within Memex itself* between agent prompts, schema, and the agent's instinct — exactly the kind of multi-surface drift a knowledge map can detect (and that a single-doc L2 system can't, because the drift isn't between spec and code, it's between prompt and primitive).

Both scenarios share a property: **drift is detectable in principle and undetected in practice**, because today's reconciliation runs only at coarse phase boundaries. Continuous, cross-axis reconciliation is the gap.

## How the spec is worked: two surfaces, one graph

A living spec is only living if two parties collaborate on it continuously: the AI agent doing the work, and the human steering it. Memex gives each its own surface, and both surfaces operate on the same nodes in the same graph.

### Memex MCP — how the agent collaborates with the spec

The agent doesn't read or write Markdown. It calls typed operations on typed primitives over the Memex MCP:

- `search_memex` — semantic + FTS across the whole knowledge map.
- `get_doc` / `list_docs` — pull a spec or enumerate active specs.
- `create_decision` / `resolve_decision` / `approve_candidate` — author and close typed decisions.
- `create_task` / `update_task` — derive tasks from the narrative and tick ACs as each one verifies.
- `assess_brief` — walk the deterministic phase rubric and surface the verdict.
- `add_section` / `update_section` — edit the consolidated narrative.

Every operation is scoped, every operation is auditable, every operation participates in the same change stream the UI watches. This is what makes "the agent works against the spec" real: the spec isn't a string the agent re-summarises every session — it's a typed surface the agent operates on with the same fidelity a human has.

### Memex UI — how the human keeps track

The human watches the same spec through the React UI at `memex.ai/<namespace>/<memex>`. Phase transitions, decision resolutions, AC walkthroughs, task ticks — everything the agent does is reflected in the UI in real time over the SSE bus. The human intervenes at gates, overrides at phase transitions, edits decisions before the agent commits to them, marks ACs out-of-scope when they don't apply.

The UI is not the spec editor. The UI is the operator console. The spec is the underlying graph; the UI is one projection, the MCP is another. Both look at the same nodes, watch the same change stream, call the same primitives. That's what makes "living" structural rather than aspirational.

## Phases are discipline

Each phase has a scoped vocabulary of legal operations:

- **plan** — author intent; resolve decisions; promise ACs; consolidate the narrative. *Don't create tasks. Don't ship code.*
- **build** — derive tasks from the narrative; execute them; tick ACs as each one verifies. *Don't retroactively change what was decided without acknowledging the drift.*
- **verify** — walk every AC individually against the running system, not against the diff. Each AC gets an independent verdict with evidence.
- **done** — the spec freezes as a durable record: this is what we promised, this is what we decided, this is what we shipped, this is what verified.

The phase tells you *what kind of work is legal right now*. Phase violations aren't process errors — they're signal that the work has out-run the spec.

## The core tenets

1. **Drift is the enemy.** Every other tenet exists to detect, surface, or prevent drift.
2. **Living over static.** A spec is only as valuable as the system's ability to keep it true. Static specs drift; living specs are continuously reconciled.
3. **Primitives over prose.** Decisions, acceptance criteria, and tasks are typed entities the system can reason about. The narrative consolidates them; it doesn't replace them.
4. **Verification is continuous and per-AC.** Each AC is walked individually against running behaviour, as part of the testing process. "Done" is a per-criterion verdict with evidence, not a vibe.
5. **Reconciliation runs between steps, not only at gates.** Coarse phase boundaries (plan→build→verify) catch *some* drift; fine-grained reconciliation between tasks (and across cited standards, sibling specs, and resolved decisions) catches the rest.
6. **The spec is a node in a knowledge map.** Search and traversal across specs, decisions, and standards is how anything gets found. The unit of retrieval is the fact, not the document.
7. **Two surfaces, one graph.** Agents work the spec via MCP; humans work it via UI. Same primitives, same change stream, real-time reflection in both directions.
8. **The spec survives the work.** Post-merge, the spec is the durable record — the answer to every future archaeology question.

## Why this matters more for AI than for humans

Humans carry context in their heads; AI agents don't. SDD treats this as the dominant constraint:

- **Context windows are bounded; the living spec is the durable context.** An agent re-entering work after compaction queries the knowledge map, not the chat history.
- **Agents can't re-derive intent from request fragments.** The spec records intent so a future agent (or future human) doesn't have to reconstruct it from prompts and diffs.
- **Verification needs a typed contract.** ACs as primitives, walked against running behaviour, are the contract the agent works against. Without them, "done" is whatever the agent says it is.
- **Drift compounds faster with AI.** An agent makes a locally-correct decision against a stale premise and ships code that satisfies its task while violating architectural intent. Without continuous reconciliation, that misalignment ships.
- **Composable handoff.** One agent plans, another builds, a third verifies — all working against the same nodes in the same map, with no lossy re-summarisation between them.

Memex isn't "better documentation." Documentation is a static artifact. Memex is the system that makes the spec a *living* artifact — typed, enforced, continuously reconciled, queryable, and shared between humans and AI agents at the same fidelity.

## What SDD isn't (and when it's overkill)

- **Not waterfall.** Living specs evolve under discipline. Backward phase transitions exist and are honest.
- **Not big-design-upfront.** A spec in `plan` is allowed to be sparse — it just has to resolve its decisions and promise its ACs before it ships code.
- **Not "wiki with extra steps."** A wiki is a document store. Memex is a knowledge map with typed primitives, enforced verification, and a shared change stream.
- **Not a process tax.** A living spec replaces ticket sprawl + PRD + design doc + post-mortem. One artifact, four jobs, continuously reconciled.

And honestly: **SDD is overkill for some work.** A single-file refactor, a dependency bump, a doc typo, a one-line bug fix — these don't need a Brief, a decision, ACs, or a phase walk. The discipline pays back when the work touches multiple files, depends on a resolved choice, or carries verification risk. For everything else, ship it and move on.

## The one-line definition

> Spec-Driven Development is engineering where the spec is a *living node in a knowledge map* — its acceptance criteria continuously verified as part of the testing process, its decisions typed and tracked, its narrative consolidated, and its state shared in real time between the AI agent (via MCP) and the human (via UI) — so that drift between intent and code is detected, surfaced, and reconciled before it compounds.
