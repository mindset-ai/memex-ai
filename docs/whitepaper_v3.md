# Memex AI

## The Workflow Layer for AI-Native Software Teams

*Whitepaper v3 — a working draft from [Mindset AI](https://mindset.ai)*

> **Naming:** v3 originally used **Mission** throughout. The user-facing noun was renamed to **Brief** (doc-26 rename) and finally to **Spec** (b-105, May 2026). This file has been updated in place: every "Mission" / "Brief" reference below now reads **Spec** / **Specs**, every `*_mission` / `*_brief` MCP tool now reads as the equivalent `*_spec` tool, and every `mission_id` / `brief_id` parameter now reads `spec_id`. The example `docType: 'mission'` in the lifecycle walkthrough now reads `'spec'`, which is what ships in the code. The v3 prose is otherwise left intact so the workflow argument still reads coherently.

---

## A note before you read this

Whitepaper v2 described a graph. Five primitives — Specs (originally called "Strategies", later "Missions", later "Briefs"), Decisions, Work Items, Blueprints, Humans — connected by traceable edges, with humans and agents free to navigate as they pleased.

We built most of it. We used it. And we hit something we didn't expect: **the graph was correct but the workflow was missing.** Teams could see all the nodes, but they couldn't tell what to do *next*. Decisions sat unresolved because nothing forced a resolution moment. Work items started before specs were finished. Implementations were "done" before anyone confirmed the user got what they actually wanted.

The system was right. The path through it wasn't prescribed.

V3 keeps the graph and adds a prescriptive workflow on top: **Specify → Execute → Validate**. Three phases, in order, with explicit gates between them. Same primitives, smaller surface, clear path.

It also drops some of v2's heavier ideas (Blueprints as a hard governance layer, decision bundles, drift detection as a pervasive feature) — see *What we cut and why* at the end. The goal is a system that's lighter to learn, stricter to follow, and easier to ship.

---

## Contents

1. [The Pitch](#the-pitch)
2. [The Three-Phase Workflow](#the-three-phase-workflow)
3. [Specify](#specify)
4. [Execute](#execute)
5. [Validate](#validate)
6. [The Primitives, Simplified](#the-primitives-simplified)
7. [Humans and Agents](#humans-and-agents)
8. [A Worked Example](#a-worked-example)
9. [MCP Architecture](#mcp-architecture)
10. [Security and Deployment](#security-and-deployment)
11. [What We Cut from v2 and Why](#what-we-cut-from-v2-and-why)
12. [The Core Bet](#the-core-bet)
13. [Getting Started](#getting-started)

---

## The Pitch

### Your AI agents are fast. Your workflow isn't.

In an AI-native team, writing code is no longer the bottleneck. **The bottleneck is the round-trip from intent to outcome:** articulating what you want, deciding the open questions, executing the work, and confirming you got what you actually intended. Most of that round-trip happens outside any tool: in Slack threads, in head-to-head AI conversations, in pull request comments, in retros nobody captures.

Memex AI is the workflow layer for that round-trip. It's a single prescribed path — Specify, Execute, Validate — that humans and AI agents move through together, with the decisions, tasks, and review trail captured as you go.

> **Three phases. Hard gates between them. Same agent in the room the whole time.**

It replaces the "epic / story / task" hierarchy with a workflow that matches how AI-native teams actually ship: spec gets shaped in conversation with an agent, work gets executed by agents, outcomes get validated against the original intent. The artifact at the centre is the **Spec** — a living document that carries the team through all three phases, end to end, from intent to validated outcome.

---

## The Three-Phase Workflow

```
   ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
   │   SPECIFY    │  ──▶  │   EXECUTE    │  ──▶  │   VALIDATE   │
   │              │       │              │       │              │
   │  Shape the   │       │  Build the   │       │  Confirm we  │
   │   intent     │       │   thing      │       │  got it      │
   │              │       │              │       │              │
   │  Spec     │       │  Tasks +     │       │  Outcome     │
   │  Decisions   │       │  agent runs  │       │  vs intent   │
   │  Review      │       │              │       │              │
   └──────────────┘       └──────────────┘       └──────────────┘
        gate                   gate                    gate
   "all decisions         "all tasks complete,    "outcome accepted
    resolved, all          all acceptance          by the steward"
    review comments        criteria green"
    addressed"
```

Each phase has:

- **A purpose** — the question it answers.
- **A primary actor** — the human role most active in it.
- **Exit criteria** — the explicit gate that has to be satisfied to advance.
- **A blast radius** — what happens if you skip it.

The Spec document lives across all three phases and accumulates state as it progresses. Status flows: `draft → review → approved → implementation → validation → done`. Skipping a phase isn't just discouraged — the system won't let the document advance until the gate is met.

| Phase | Question it answers | Primary actor | Exit gate |
|-------|---------------------|---------------|-----------|
| **Specify** | *What are we building, and is everyone aligned?* | Steward (PM, lead, founder) | All decisions resolved · all review comments resolved · spec marked approved |
| **Execute** | *Are we building it correctly?* | Implementer (engineer + AI agent) | All tasks complete · all acceptance criteria satisfied |
| **Validate** | *Did we get what we wanted?* | Steward | Outcome verified against intent · sign-off recorded |

---

## Specify

### Shape the intent until everyone — and every agent — can act on it

The Specify phase is where ambiguity dies. It produces a Spec document that any human or AI agent can pick up cold and execute against.

A Spec in Specify looks like this:

- **Purpose** — the problem, the motivation, what success looks like. A few paragraphs, not a sentence.
- **Approach** — the architectural shape of the solution. Enough that an implementer doesn't have to invent.
- **Decisions** — every non-obvious choice, surfaced as a first-class object with options, trade-offs, and (eventually) a resolution. Stable IDs (`dec-1`, `dec-2`).
- **Review comments** — the conversation. Questions, objections, suggestions, threaded against specific sections or decisions.

### How a Spec gets built

You start in your coding tool. You say: *"I want to add proactive role discovery — help me think through this."* The Memex agent calls `create_doc` (creating a `spec` docType) and you start a collaborative drafting session. The agent reads the relevant code, drafts sections, surfaces decisions as it recognises them, and updates the Spec in place.

Three things differentiate this from "AI writes a doc":

1. **Decisions surface as you go, not at the end.** When the conversation hits a non-obvious choice, the agent creates a `dec-N` with options and trade-offs. You either resolve it inline ("server-side, obviously") or leave it open with a `[Focus]` chip on the decision card so it stays visible.
2. **Review is part of the phase, not a separate step.** Other team members open the Spec in the React UI and leave comments — typed (`question`, `review`, `plan_revision`, `approval`) and threaded against specific sections or decisions. Their AI agent has full context too.
3. **The codebase is in the room.** The agent reads source while drafting. Sections reference real files, real symbols, real endpoints. The spec describes what *will* exist on top of what *does* exist.

### Exit gate: spec is approved

A Spec can't leave Specify until:

- Every `dec-N` is `resolved` or explicitly `deferred` (with a deferral reason recorded).
- Every comment of type `question`, `review`, `plan_revision` is `resolved` (replied to and closed) or explicitly punted to a future Spec.
- The steward marks the Spec `approved`.

That last step is a human action — an agent can request approval, but it can't grant it. Approval is the moment the steward says: *"yes, this is what we're building."*

### Why this is the slowest phase, on purpose

Specify is the only phase where decisions are cheap to change. Once you cross into Execute, the cost of reshaping intent goes up by an order of magnitude. The phase is designed to surface every objection, every ambiguity, every missing decision *now* — when the cost of fixing them is conversation, not code.

If you find yourself looping back into Specify from Execute, that's not a failure of the system; that's the system telling you the spec wasn't ready. The gate held.

---

## Execute

### Build the thing, with agents in the loop, with progress visible

Execute is what most existing project management tools optimise for. Memex's Execute phase is deliberately thinner — most of the heavy thinking happened in Specify. Here, the loop is mechanical: scope tasks, agents pick them up, progress streams in, acceptance criteria turn green.

### Tasks

A task in Memex is small, scoped, and acceptance-tested:

- **Goal** — one sentence.
- **Acceptance criteria** — a checklist. Concrete, testable, written by a human (or proposed by the agent and reviewed by a human) before any code is written.
- **Dependencies** — explicit links to other tasks (DAG). No estimation points, no sprint assignment, no "as a user, I want..." narrative.
- **Status** — `not_started`, `in_progress`, `complete`.

`get_ready_tasks(spec_id)` returns the set of tasks whose dependencies are all met. That's what the team works on. It's the answer to *"what can we actually do right now?"* and it changes as work completes.

### The agent run

When a task is picked up by an agent, the run looks like this:

1. Agent reads the task, the parent Spec, the resolved decisions that constrain it, and the relevant code.
2. Agent posts a spec plan as a comment on the task — what it's about to do, what files it will touch, what's unclear.
3. The steward (or an implementer) glances at the plan and either accepts ("go") or pushes back ("not that file, the other one").
4. Agent executes. Progress is streamed back as `progress` comments on the task — "tests added", "schema migration drafted", "encountered X, here's how I'm handling it."
5. Agent completes the task and updates the acceptance checklist.

This is where a lot of v2's machinery — Blueprints, drift detection, the formal Execution Plan gate — gets simplified. In v3 the "execution plan" is just the agent's plan comment. It's reviewed in chat, not in a separate artifact. If the team needs more rigor, they raise the bar on what they accept as "go".

### Exit gate: all tasks complete, all criteria green

Execute exits when every task in the Spec is `complete` and every acceptance criterion is checked off. The Spec moves to `validation`.

### What about new decisions during Execute?

They happen. Often. An implementer hits a question the spec didn't answer.

Two paths:

1. **Small/local** — log a decision against the Spec, resolve it inline, keep moving. The decision is captured for posterity but doesn't bounce the Spec back to Specify.
2. **Large/cross-cutting** — the implementer flags it. The Spec reverses to Specify status. The team resolves it. Then Execute resumes.

The second path is intentionally heavy. It's a bug in the system if you keep needing it.

---

## Validate

### Did we get what we wanted?

Validate is the phase that doesn't exist in most project management tools, and it's where we think the biggest wins are.

A task being "complete" is not the same as the Spec being "successful." Acceptance criteria can be green and the user can still be unhappy with the outcome. The button works but the flow feels wrong. The migration finished but the rollback path is unclear. The feature ships but nobody can tell whether it moved the metric.

Validate is the explicit phase where the steward — the person who articulated the intent in Specify — confirms the outcome matches the intent.

### What happens in Validate

The steward (or the agent acting under their direction) walks through:

1. **The original purpose statement** — does the implementation actually address the problem we set out to solve?
2. **Each resolved decision** — was the resolution honoured in the code? (The agent can check this directly: look at the decision, look at the relevant code, report.)
3. **The acceptance criteria as a whole** — beyond each individual checkbox, do they collectively prove the thing works?
4. **The unspecified parts** — is there obvious behaviour the spec didn't cover that the implementation got wrong?
5. **The trailing items** — drift comments, deferred decisions, follow-on TODOs that should be captured before the Spec closes.

The agent does the heavy lifting. It compiles a **validation report**: each item above, with evidence (links to code, links to test runs, links to specific comments), and a recommendation. The steward reviews the report, runs the feature themselves where appropriate, and either accepts the outcome or sends specific items back to Execute.

### Exit gate: outcome accepted

The Spec can't move to `done` until the steward signs off. Sign-off is recorded as an `approval` comment on the Spec. The system stamps the time and the user.

### Why this matters

Without Validate, the loop closes silently. The Spec is "done" because the tasks finished. Nobody actually compared the outcome against the original intent — and small drifts compound across Specs. The button works in isolation. The flow is wrong in aggregate. The team accumulates technical debt that's invisible because the decisions that produced it were never re-examined.

With Validate, the loop closes with the same person who opened it. The intent is reaffirmed or the work is sent back. Either way, the system records what was true at the moment of sign-off.

---

## The Primitives, Simplified

V3 keeps four primitives. That's it.

| Primitive | What it is | Where it lives in the workflow |
|-----------|------------|--------------------------------|
| **Spec** | The living document. Purpose, approach, sections. Carries state across phases — from intent through execution to validated outcome. | All three phases |
| **Decision** | A non-obvious choice with options and a resolution. Stable IDs (`dec-N`). | Mostly Specify; sometimes Execute |
| **Task** | A scoped unit of work with acceptance criteria. Stable IDs (`t-N`). DAG-linked. | Execute |
| **Comment** | The conversation. Typed (`question`, `review`, `progress`, `approval`, etc.). Resolvable. | All three phases |

### What's gone from v2

- **Blueprints as a fifth primitive.** They're now a deliberate non-primitive. See *What We Cut* below.
- **Humans as a fifth primitive.** Humans are actors, not nodes in the graph. They sign off, they comment, they steward — but the system doesn't model them as edges in a knowledge graph (that idea was load-bearing in v2 and turned out to be both heavy and underutilised).
- **The "promotion path"** (a work item becoming its own Spec). Replaced by: copy/spawn a new Spec and reference the old one in its purpose. Cleaner, fewer edge cases.
- **Cross-Spec dependencies.** Replaced by: a comment on the dependent Spec that links to the upstream one. Cheap, explicit, doesn't require a new edge type.

### Why fewer primitives

Every primitive is a thing the user has to learn, the system has to display, the agent has to choose between, and the codebase has to maintain. Four is enough to express a software-engineering workflow. Five was honest in v2; in practice it diluted the focus.

---

## Humans and Agents

### Both are actors. Neither is a primitive.

In v2, "Humans" was a fifth primitive in the graph — the system was meant to learn who knows what and route work accordingly. We built the substrate for it (user attribution on every comment, role data on every membership) but never built the routing. In hindsight, modelling humans as graph nodes was the wrong abstraction. The right one is simpler: **humans are actors with roles in the workflow.**

| Role | Lives mostly in | Does |
|------|-----------------|------|
| **Steward** | Specify, Validate | Articulates intent, resolves the decisions that matter, signs off the outcome |
| **Implementer** | Execute | Picks up tasks, runs agents, reviews their plans, ships |
| **Reviewer** | Specify (Review) | Comments on the spec, raises questions, approves or pushes back |
| **AI agent** | All three | Drafts, codes, summarises, validates — wherever a human directs it |

The same person plays multiple roles in a week. The roles are conventions, not entities. Memex doesn't need to model them in the schema; it just needs to route notifications and gate sign-offs.

### Where AI agents fit

Agents do the volume work. They draft purpose statements, surface decisions, propose tasks, write code, run tests, compile validation reports. They're the difference between a Spec taking a week to specify and an hour.

But agents don't:

- Decide what's worth building. (Steward, in Specify.)
- Approve a spec for execution. (Steward, exit of Specify.)
- Sign off the outcome. (Steward, exit of Validate.)

These three moments are the human-only gates. Everything else, an agent can do — and most of it, an agent does.

> **You are the chef. AI is the sharpest knife you've ever worked with. The dish is still yours.**

---

## A Worked Example

A real Spec, walked through all three phases. Compressed.

### Specify

Steward, in their coding tool: *"I want to add a caching layer for the discovery match results. Help me think through this."*

Agent calls `create_doc(type='spec', title='Discovery Match Caching')`. Drafts the purpose against the actual code. Surfaces three decisions:

```
dec-1  Cache invalidation approach: TTL vs write-through vs Pub/Sub  [open]
dec-2  Cache backend: Redis vs Valkey vs in-process                  [open]
dec-3  Cache key shape: candidate_id alone or candidate × profile_v  [open]
```

Steward resolves `dec-1` (TTL, with a follow-on dec for adaptive TTL). They invite a teammate to review. Teammate leaves a comment: *"Why not Pub/Sub? We already run it for the audit pipeline."* — a `question` comment on `dec-1`. The conversation continues; the team flips `dec-1` to Pub/Sub and updates the rationale.

Two days later: all three decisions resolved, four review comments resolved, steward marks the Spec `approved`. Specify exits.

### Execute

Spec is now in `implementation`. Five tasks scoped during Specify; the agent picks up the first ready one.

```
get_ready_tasks(spec=...) →
  t-1: Add cache layer to match_engine.py  [ready]
  t-3: Wire Pub/Sub invalidation on profile change  [ready]
  Blocked:
  t-2: Add metrics  [waiting on t-1]
  t-4: Backfill cache for top 1000 profiles  [waiting on t-3]
  t-5: Update operations runbook  [waiting on t-1, t-3]
```

Agent reads `t-1`, posts a plan comment: *"I'll add a Redis-backed cache wrapper around `match_engine.compute()`. Touches `match_engine.py`, `redis_client.py`, and adds a feature flag in `flags.yaml`. About 40 lines. OK to proceed?"* Steward says go. Agent ships. Progress comments stream in. Acceptance criteria turn green.

Repeat for `t-2` through `t-5`. Three days later, all five tasks complete. Spec moves to `validation`.

### Validate

Agent compiles the validation report:

> *Validation Report — Discovery Match Caching*
>
> **Purpose:** Reduce match latency from ~400ms to <50ms on repeat lookups.
> **Outcome:** Cache hit rate at 78% in staging; p50 latency 22ms, p95 47ms. Purpose met.
>
> **dec-1 (Pub/Sub invalidation):** Honoured. `match_engine.py:142` subscribes to `profile.updated`. Verified.
> **dec-2 (Redis backend):** Honoured. New `redis_client.py` with connection pool.
> **dec-3 (Key shape):** Implementation uses `candidate × profile_v` as resolved.
>
> **Acceptance criteria:** 5/5 green.
>
> **Trailing items:**
> - Comment from `t-2` mentioned an unhandled edge case for Pub/Sub disconnect. Filed as a new Spec: *Cache resilience under broker outage*. Linked.
> - Operations runbook (`t-5`) was updated but the on-call rotation hasn't been notified. Recommend before sign-off.

Steward reviews. Pings the on-call lead, confirms runbook awareness, signs off. Spec moves to `done`. Time stamped, user stamped.

The next Spec that touches caching loads this one as referenceable context. The decisions are first-class, the validation report is preserved, the trailing Spec is linked. Nothing was lost.

---

## MCP Architecture

### MCP-native, with a smaller tool surface

V3 keeps Memex's MCP-native architecture. Any AI agent — Claude Code, Cursor, Copilot, custom — connects to the same Memex server via the Model Context Protocol and gets the full Spec, decision, task, and comment graph through standard tool calls.

The tool surface is smaller than v2. Some tools are gone (extraction bundles, blueprint mgmt, decision impact across Specs); others have been folded together. The surface now mirrors the three phases:

```
# Workspace
list_memexes()
list_docs(memex)
get_doc(id)
get_doc_url(id)

# Specify phase
create_doc(memex, title)
update_doc_status(id, status)        # → review, approved
add_section(doc_id, ...)
update_section(section_id, ...)
create_decision(doc_id, question, options)
resolve_decision(id, choice, rationale)
reopen_decision(id, reason)
add_comment(target, content, type)
list_comments(target)
list_doc_comments(doc_id)
resolve_comment(id, resolution)
review_doc_comments(doc_id)          # bulk review helper

# Execute phase
create_task(doc_id, goal, criteria, deps)
list_tasks(doc_id)
get_task(id)
update_task(id, ...)
update_task_status(id, status)
get_ready_tasks(doc_id)
add_blocker(task_id, blocker)        # task or decision
remove_blocker(task_id, blocker)

# Validate phase
compile_validation_report(doc_id)    # NEW: agent assembles the report
record_signoff(doc_id, approver, notes)
```

Compared to v2, gone:
- All blueprint tools (`get_blueprint`, `flag_blueprint_drift`, `update_blueprint`, ...)
- Decision extraction / bundle tools (`extract_decisions`, `create_decision_bundle`, `approve_bundle`)
- Spec draft tools (`create_spec_draft`, `publish_spec` — names from the v2 design) — replaced by generic document status transitions
- Cross-Spec impact tools (`get_decision_impact`, `get_dependents` across Specs)

The full surface in code today is larger (~57 tools, including codebase-intelligence read tools that aren't part of the workflow itself). V3's surface is what the *workflow* uses; codebase tools remain available as a separate, optional surface for teams that want grounding.

---

## Security and Deployment

Unchanged from v2. Two deployment modes, your data your choice.

| Hosted SaaS | Self-hosted |
|-------------|-------------|
| We run it. Sign up, connect an agent, start. Simplest path. | One Docker container + one Postgres. Any VM. **100% of your data inside your infrastructure.** Bring your own LLM keys. |

Both expose the same MCP surface, the same UI, the same features. Self-hosted has no outbound calls except the LLM provider you configure.

> If your codebase lives in your infrastructure, your Memex should be able to live there too.

The graph is portable — it's just Postgres. Migrate between SaaS and self-hosted whenever your data policy demands it.

---

## What We Cut from v2 and Why

V2 was honest about its scope; v3 is honest about what we tried, what worked, and what we're stepping back from.

### Cut: Blueprints as a hard governance layer

**V2 promise:** Blueprints (deployment, testing, security, etc.) loaded automatically before agent work. Agents stop if a rule is violated. Drift detected continuously.

**Reality:** We built the data structure (blueprint-typed documents, drift comments) but never the enforcement. Teams found that what they actually needed was *the latest decision in the Spec*, not a separately-maintained "deployment blueprint." Blueprints duplicated information that was already in resolved decisions and existing CLAUDE.md / cursor rules files.

**V3 position:** Blueprints aren't a primitive. The decisions made *inside* Specs are the source of truth; agents can compile a per-domain rulebook from them on demand. We may bring a slimmer "team blueprint" concept back later as a lightweight rollup, but it won't be a fifth pillar. Existing repo-level files (`CLAUDE.md`, etc.) keep working.

### Cut: Decision bundles and passive extraction

**V2 promise:** Agents extract decisions silently from human-AI conversations, batch them into "bundles," surface them at natural pause points for lightweight review.

**Reality:** We built `propose_decision` / `approve_candidate` / `reject_candidate` as the primitives. Agents do propose decisions inline. But the *bundle* abstraction — batching multiple decisions for a single review pass — never got built and we no longer think it's needed. Reviewing decisions one at a time, in the Spec where they live, with full context, is faster than batching and reviewing them out of context.

**V3 position:** Decisions are proposed inline by the agent during Specify. They're resolved inline by the steward. No bundle UX.

### Cut: Drift detection as a pervasive feature

**V2 promise:** Four flavours of drift detection — agent-reported, decision-triggered, implementation-triggered, scheduled audits.

**Reality:** Agent-reported drift is useful and we kept it (as a comment type). The other three never paid for themselves; they generated noise more than signal.

**V3 position:** Drift is a comment type. An agent or human flags it explicitly when they see it. Anything fancier waits for a real demand signal.

### Cut: Cross-Spec dependencies as first-class edges

**V2 promise:** Work items in different Specs link explicitly; resolving one cascades to the other.

**Reality:** The cascade logic was complex and rarely needed. When a real cross-Spec dependency exists, a comment with a link is sufficient.

**V3 position:** No edge type. Use a comment that references the other Spec.

### Cut: Humans as a primitive, expertise routing

**V2 promise:** Memex learns who knows what, routes decisions and reviews to the right human automatically.

**Reality:** We have the substrate (per-comment user attribution, role data per membership). We never built the inference layer because we couldn't make it useful without becoming creepy. Teams told us: *"just let me @mention people."*

**V3 position:** Humans are actors, not graph nodes. @mentions and notifications are enough.

### Kept (and central): the workflow gates

**V2 promise (implicit):** Status transitions happen freely; the discipline is up to you.

**V3 position:** Status transitions are gated. You cannot move to Execute without resolved decisions and addressed reviews. You cannot move to Done without an approved validation report. The system enforces the gate; the team can't quietly skip it. **This is the single biggest change from v2.**

---

## The Core Bet

The history of software tooling follows the bottleneck:

1. **Compilation** → better compilers
2. **Integration** → CI/CD
3. **Communication** → agile and Scrum
4. **Deployment** → Kubernetes, IaC
5. **Decisions and intent** (v2 bet) → Memex's graph of Specs, decisions, work, blueprints
6. **The full intent → outcome loop** (v3 bet) → a prescribed three-phase workflow that humans and agents move through together

V2 was right that decisions are first-class. V3 is the next step: **decisions are first-class, but they only matter inside a workflow that forces alignment up front and outcome verification at the end.** Without the workflow, the graph rots; the discipline doesn't survive contact with a Tuesday afternoon.

Memex AI is the workflow tool for AI-native teams. Three phases. Hard gates. Same agent in the room across all of them.

---

## Getting Started

### Early access, opinionated workflow

Memex AI is in the hands of a small group of teams right now, ourselves included. V3's workflow is a deliberate narrowing — if you've felt v2's surface area was too much, this is for you.

### What to expect

- **Specify a Spec in 30–60 minutes** with the agent in your coding tool.
- **Execute the Spec with agents picking up tasks** while you stay in flow.
- **Validate the outcome in minutes**, not at the end of a quarter.

Both SaaS and self-hosted modes are available. Bring your own LLM keys. Run it where your data is allowed to live.

### Join the waitlist

> **[memex.ai](https://memex.ai/)** — request early access.

---

*Memex AI: because shipping software was always more than just writing the code.*

*Whitepaper v3 — a working draft from [Mindset AI](https://mindset.ai). If anything here feels off, tell us.*
