# Memex AI

## The Decision Layer for AI-Native Software Teams

*A whitepaper from [Mindset AI](https://mindset.ai)*

> **Superseded — historical reference.** This is **whitepaper v2**, kept for narrative continuity. The current narrative is [whitepaper_v3.md](whitepaper_v3.md), and the public marketing positioning lives in [whitepaper.md](whitepaper.md).
>
> **Naming:** v2 originally used **Strategy** as the user-facing noun for the top-level living document. That was renamed to **Mission** (see dec-2 in `t-6` of the Memex.AI building-itself memex), then to **Brief** (doc-26 rename), and finally to **Spec** (b-105, May 2026). This file has been updated in place: every "Strategy" / "Strategies" / "Mission" / "Brief" reference below now reads **Spec** / **Specs**, every `create_strategy_draft` / `publish_strategy` (and the matching `*_mission` / `*_brief`) tool name now reads as the equivalent `*_spec` tool (`create_spec_draft`, `publish_spec`, etc.), and "cross-strategy" framing now reads "cross-spec". The v2 prose is otherwise left intact so the historical argument still reads coherently.

---

## Contents

1. [The Pitch](#the-pitch)
2. [Our Story](#our-story)
3. [The Problem](#the-problem)
4. [The Memex Graph — Five Primitives](#the-memex-graph--five-primitives)
5. [Specs](#specs)
6. [Decisions](#decisions)
7. [Work Items](#work-items)
8. [Blueprints](#blueprints)
9. [Humans](#humans)
10. [Drift Detection](#drift-detection)
11. [MCP Architecture](#mcp-architecture)
12. [Roles](#roles)
13. [The Lifecycle](#the-lifecycle)
14. [Building a Spec](#building-a-spec)
15. [Decision Extraction](#decision-extraction)
16. [Security and Deployment](#security-and-deployment)
17. [Why Not Just Use Existing Tools?](#why-not-just-use-existing-tools)
18. [Before and After](#before-and-after)
19. [The Core Bet](#the-core-bet)
20. [Getting Started / Early Access](#getting-started--early-access)

---

## The Pitch

### Your AI agents are brilliant. They're also building the wrong thing.

Every day, AI coding agents ship thousands of lines of code across your organisation. They're fast, tireless, and increasingly capable. But ask yourself: how does Agent A know what Agent B decided yesterday? How does the agent refactoring your authentication module know that the team resolved, three weeks ago, to migrate away from JWTs? How does the agent writing your deployment script know that staging now requires a VPN, because someone changed the infrastructure last Tuesday and never updated the docs?

It doesn't. And neither does the new developer who joined on Monday.

> **The bottleneck in modern software development is no longer writing code. It's making decisions, and making sure everyone (human and AI) knows what was decided, why, and what it means for the work ahead.**

Memex AI is the spec, decision, and knowledge layer purpose-built for teams where AI agents do the implementation work. It replaces the agile artefact hierarchy (epics, stories, tasks) with a structure that reflects how software actually gets built today:

- **Specs** that articulate the objective
- **Decisions** that resolve ambiguity
- **Work items** that agents can execute
- **Blueprints** that stay current because the system won't let them rot
- **Humans** who stay at the centre of the decisions that matter

> **You are not redundant. You are the chef. AI elevates you.**
>
> Our roles in software are evolving. Our humanity is not. Memex is built on the belief that AI agents are the sharpest tools a team has ever had, and that humans are still the creative drivers, the decision makers, and the stewards of the craft.

---

## Our Story

### We built Memex because we lived the problem

Mindset AI is an AI company. Our mission is to leverage AI to bridge the gap between human ability and human ambition, and we've been applying that to ourselves first.

Every engineer on our team works with coding agents daily. Our product people design in conversation with AI. Our support team uses AI to triage and respond. We aren't just building AI agents, we're running an AI-native company, and the way we operate is documented openly in our MOS (Mindset Operating System).

Working this way taught us something we didn't expect.

### The bottleneck shifted, and nobody's tools caught up

When we started, we assumed the hardest part of AI-assisted engineering would be **code quality**. It wasn't. Modern coding agents produce good code when they know what they're trying to build.

The hard part turned out to be **context**.

- An agent gets handed a ticket scoped in a Slack thread last month, written for a system that's since changed twice.
- Two engineers each have a side conversation with their agent. Each arrives at a decision. Those decisions contradict each other, and nobody knows until the PRs collide.
- A new agent loads a wiki page that was last updated two quarters ago and confidently implements against yesterday's architecture.
- The team re-prioritises. Half the decisions that shaped the previous plan are invalid now. Nobody can trace which ones.

These aren't edge cases. They were happening to us every week. And the harder we leaned on AI agents, the more acute they got, because the agents amplified the context problem rather than solving it.

### This is the most exciting moment in software in a generation

Step back for a second, because it's easy to miss what's actually happening.

In the last eighteen months, software engineering has changed more than it did in the previous decade. Code that used to take weeks takes hours. Tasks that needed three engineers take one engineer and an agent. A new developer, human or AI, can ship production code on day one. Entire categories of work — refactors, migrations, test coverage, boilerplate — have moved from painful to trivial.

The work isn't disappearing. It's moving up the stack. From *how* to *what*. From implementation to intent. From typing code to shaping decisions.

This is a rare inflection point. For most of our careers, the way software gets built has been slowly accumulating cruft: story points, sprint planning, handoff rituals, wikis nobody reads. None of it was wrong for its time. It just doesn't match the shape of the work anymore.

Every team right now has the chance to reshape how they work from first principles. That's an extraordinary opportunity. Memex AI is our bet on what a tool for the new shape of the work looks like, and we're genuinely excited to be building it in public, with other teams who feel the same.

### The Theorem of Constraints, applied to ourselves

One of the mental models that shapes how we run Mindset is the Theorem of Constraints: any interconnected process operates at the speed of its slowest part. We're allergic to bottlenecks in our own organisation, and we look for them constantly.

When we applied that lens to AI-assisted development, the bottleneck was unmistakable: **it wasn't writing code, it was capturing, propagating, and maintaining decisions** across humans and agents.

Memex AI is the system we built to remove that bottleneck. It started as internal infrastructure. We use it every day. We're now making it available to every team that's hitting the same wall.

---

## The Problem

### The world moved on. The tools didn't.

Agile project management was designed in 2001 for teams of humans who needed work broken into predictable, estimable chunks. The artefact hierarchy (Epic → Story → Task → Subtask) is a communication protocol between people sitting in the same room, negotiating scope at a whiteboard.

Twenty-five years later:

- AI agents write production code, generate tests, perform research, and handle deployments
- Teams are distributed across time zones, and "the room" is a Slack thread
- The rate of change has outpaced any human's ability to maintain a mental model of the system
- Decisions that once lived in someone's head now need to be machine-readable

Yet we're still forcing this reality into tools built for a different era. We write stories for agents that don't need narrative. We estimate points for work that takes minutes. We maintain wikis that are wrong by the time they're published.

> **The result is predictable: AI agents produce incoherent work because they lack shared context.**

### Three failures that compound daily

#### 1. Decisions are invisible, in both directions

In every existing project management tool, a decision is a comment buried in a ticket, a message lost in a Slack channel, or a vague memory from last month's planning session. There is no canonical place where "we decided X because of Y" lives as a first-class, referenceable object.

But the problem is now bidirectional. The old failure mode was human decisions not reaching agents. The new failure mode, already happening in every team using AI tools, is that **decisions made during human–AI conversations don't reach other humans or their agents.**

A developer spends an hour with their AI agent working through an architectural problem. They explore options, weigh trade-offs, and arrive at a decision. That decision is now locked in a conversation thread that nobody else can see. The next developer working on a related feature has no idea the decision was made. Their agent has no idea either. Two people made two contradictory decisions, each with their own AI agent, in two separate conversations, on the same Tuesday afternoon.

This is the new shape of invisible decisions. They're not buried in Slack or lost in meeting notes. They're **locked in AI conversation threads**, and the volume is growing because human–AI planning sessions are now where most design thinking happens.

When priorities shift (and they always shift), teams can't trace which decisions are affected, which work items depend on them, or what downstream consequences follow. Re-prioritisation becomes chaos because the decision graph was never explicit.

> *A developer's AI agent picks up a ticket to build a caching layer. It doesn't know the team decided last week to move from Redis to Valkey. It builds the Redis implementation. The PR gets rejected. The agent's work is wasted. The developer's afternoon is wasted reviewing code that should never have been written.*

#### 2. Institutional knowledge decays

Every team has accumulated knowledge about how things work: deployment procedures, coding conventions, architectural boundaries, security requirements, design principles. This knowledge lives in READMEs that were accurate six months ago, in wiki pages nobody maintains, and in the heads of senior engineers who haven't updated the onboarding docs since they were onboarded themselves.

For human developers, this is friction. For AI agents, it's fatal. An agent doesn't have tribal knowledge. It can't ask the person sitting next to it. When it loads a stale document that says "deploy with `kubectl apply`" but the team moved to ArgoCD three sprints ago, the agent follows the document. Confidently. Incorrectly.

> *The testing conventions document says to mock the database. The team stopped doing that after a production incident where mocked tests passed but the real migration failed. A new AI agent reads the document, mocks the database, writes tests that pass against the mock, and the team ships a broken migration. Again.*

#### 3. No coordination between agents

When two AI agents work on related parts of a system simultaneously (and this is increasingly common), there is no mechanism for them to share context. Agent A modifies a shared interface. Agent B, working from an outdated understanding of that interface, produces code that won't compile. Neither agent knows the other exists.

This isn't a hypothetical. It's happening right now in every team running multiple AI agents against a shared codebase. The agents are individually competent and collectively incoherent.

### The cost is staggering, and hidden

These failures don't show up as a line item. They show up as:

- PRs that get rejected because the agent didn't know about a recent decision
- Duplicated work when two agents solve the same problem differently
- Debugging sessions caused by stale documentation
- Onboarding time for new team members (human or AI) that stretches from days to weeks
- The slow, invisible drift of a codebase away from its own architectural principles

> **What if the system that held your decisions, your work, and your institutional knowledge was the same system your AI coding agents read from before writing a single line of code?**

That's Memex AI.

---

## The Memex Graph — Five Primitives

Memex AI is built on a simple structural insight. An AI-native software team runs on five connected primitives: four that describe the work, and one that describes the people doing it.

| Primitive | Role |
|-----------|------|
| **Spec** | The objective. What we're trying to achieve and why. Every spec spawns decisions and work. |
| **Decisions** | The leading edge. What we're figuring out. Each belongs to a spec. Drives prioritisation and unblocks work. |
| **Work Items** | The work graph. What needs doing. Agents claim, plan, and execute. |
| **Blueprints** | The shared contracts. The rules for how software gets built here. Transcend specs. Contracts between humans and AI. |
| **Humans** | The creative drivers. People with names, taste, and context. Memex learns who knows what. The bridge between nameless AI agents and the team that cares. |

### How they connect

These five primitives are connected by explicit, traceable links:

- **Specs** contain **Decisions** and **Work Items**, they're the organising boundary
- **Decisions** block or unblock **Work Items** within (and sometimes across) specs
- **Resolved Decisions** can update **Blueprints** when they change how software is built
- **Blueprints** govern how **Work Items** are executed, every work item runs against the current blueprint contract
- **Completed Work Items** may surface new **Decisions** or require blueprint updates
- **Implementation changes** trigger **Blueprint reviews** (drift detection)
- **Work Items** that outgrow their scope get **promoted to their own Spec**
- **Humans** create, review, comment on, and own every other primitive; Memex learns who holds what expertise and routes the right work to them

This isn't five separate tools stitched together. It's one graph. Specs give decisions and work items their purpose. Decisions are the leading edge. Work items are the execution. **Blueprints sit across all of it, the shared substrate every spec runs on. Humans sit alongside, the people the system exists to serve and elevate.**

---

## Specs

### The container for everything

A **Spec** is the top-level construct in Memex AI. It represents an objective the team is trying to achieve: a product initiative, an architectural migration, a platform capability, a compliance requirement. It's the answer to *"why are we doing any of this work?"*

A Spec contains:

- **A purpose statement** — the problem or opportunity, in enough depth that anyone (human or AI) can understand the motivation without a briefing
- **The architectural vision** — how the solution fits into the broader system, what principles guide it
- **Decisions** — the non-obvious design choices that must be resolved to move forward
- **Work Items** — the scoped units of implementation, linked to decisions and to each other

Specs are the boundary that prevents context from sprawling. When an agent picks up a work item, it loads the spec that contains it, not the entire organisational knowledge base. A team might have five active specs. Each is self-contained: its own decisions, its own work items, its own dependency graph.

### The promotion path

Work sometimes outgrows its container. A work item scoped as *"add a caching layer"* might reveal a design problem with its own market context, architectural trade-offs, and multiple sub-work-items. When this happens, the work item is **promoted** to its own Spec. The link to the parent spec is preserved, so you can always trace how a spec was born.

### Cross-spec dependencies

Specs are self-contained but not isolated. A work item in Spec B might depend on infrastructure delivered by Spec A. These cross-spec links are explicit and tracked. When Spec A's work item ships, Spec B's blocked items are automatically unblocked.

### Why this matters

Without a spec, decisions and work items are just a flat list. The spec provides the *why* that makes every decision intelligible and every work item purposeful.

| Without a Spec | With a Spec |
|--------------------|-----------------|
| *"We decided to use PostgreSQL."* Arbitrary, untraceable, forgotten in a month. | *"We decided to use PostgreSQL because our discovery matching engine needs pgvector for embedding similarity, and the spec requires sub-100ms lookups across 3,000 occupation vectors."* Traceable to a goal. |

In the old world, this was an Epic. But an Epic is a label on a group of tickets. A **Spec is a living document** that holds the reasoning, the open questions, and the architectural context that every agent needs before touching the code.

---

## Decisions

### First-class, not afterthoughts

In Memex AI, every non-obvious design choice is a **Decision** with:

- **A stable ID** (`D1`, `D2`, ...) — referenceable from any work item, blueprint, or conversation
- **Status** — Open, Leaning, or Resolved
- **Options** — the plausible alternatives, with trade-offs
- **Resolution** — what was chosen, why, and what was rejected
- **Impact links** — which work items are blocked, which blueprints are affected

Decisions are not documentation. They are **active objects in the system.** An open decision is a blocker. A resolved decision is a constraint. When priorities change, you re-open and re-resolve decisions, and the system traces the downstream impact automatically.

### Why decisions are first-class

**For AI agents:** An agent asked to implement a caching layer checks Memex AI first. It sees `D7: Cache invalidation strategy` is still open with three options under consideration. The agent **stops and reports this** rather than guessing. The team resolves `D7`, and every agent working on related features immediately has the answer.

**For humans:** When a stakeholder asks *"why did we build it this way?"*, the answer isn't buried in a Slack thread from four months ago. It's `D7`, resolved on March 3rd, with the full rationale and rejected alternatives preserved.

### Anatomy of a decision

```
D7 · Cache invalidation strategy                    [OPEN]
Spec: S3 — Proactive Role Discovery

Options
  A. Time-based TTL (simple, may serve stale)
  B. Write-through invalidation (complex, always fresh)
  C. Event-driven via Pub/Sub (flexible, more moving parts)

Blocks
  WI-3  Agent conversation flow
  WI-4  Discovery integration

Affects blueprints
  caching, data-model
```

When resolved, the record keeps the options and rejected alternatives. Future contributors (human and AI) can see not just what was chosen but what was considered and why the others lost.

### Where decisions come from

Most decisions in a healthy Memex graph are not created by someone pausing to fill in a form. They're captured passively from human–AI planning conversations and surfaced for lightweight review. See [Decision Extraction](#decision-extraction).

---

## Work Items

### A dependency graph, not a backlog

Work Items in Memex AI are not stories. They don't have estimation points, acceptance criteria written as *"As a user, I want..."*, or sprint assignments. Each work item has four properties:

- **Goal** — one sentence describing what it achieves
- **Dependencies** — explicit links to other work items AND unresolved decisions that block it
- **Acceptance Criteria** — concrete, testable checklist
- **Status** — Not Started, Blocked (with reason), In Progress, or Complete

Work Items form a **directed acyclic graph (DAG)**, not a flat backlog. `WI-4` depends on `WI-1`, `WI-2`, and `WI-3`. It also depends on `D5` and `D9` being resolved. The system knows this and can answer the question every team asks constantly: *"What can we actually work on right now?"*

```
get_ready_work_items() →
  WI-2: Profile schema redesign     [all dependencies met]
  WI-6: Teleworkability enrichment  [all dependencies met]

  Blocked:
  WI-3: Agent conversation flow     [waiting on D7, D8]
  WI-4: Discovery integration       [waiting on WI-1, WI-3]
```

### The Execution Plan gate

Before an agent writes code for a work item, it must produce an **Execution Plan**: a reconciliation of the work item's requirements against the actual codebase. The plan lists files to modify, dependency flow, and conflicts found between the design and reality. These conflicts *always* exist. The execution plan is where they surface, before they become bugs.

> **No coding happens until the execution plan is reviewed.** This is the single most effective quality gate for AI agents, because it forces the agent to ground its understanding in the actual code rather than hallucinating an implementation from the specification alone.

### Why the DAG beats the backlog

A backlog is a list. A list says nothing about readiness: you stare at 80 tickets and guess which one won't blow up first. A DAG says *"these three are unblocked, these six are waiting on a decision, these two are waiting on upstream work that's still in flight."* That's the question you actually want answered, every standup, every Monday, every time an agent asks what to do next.

---

## Blueprints

### The shared contracts between humans and AI

Blueprints are the **rules for how software gets built here**. They're the design systems, architectural guidelines, security processes, testing conventions, and operational procedures that govern every piece of work, regardless of which spec it belongs to.

They transcend specs. They outlive specs. They bookend the process, a reference when work starts, a checklist when work ships.

| Documentation says | A Blueprint says |
|-------------------|------------------|
| *"Here's how authentication works."* Descriptive, passive, written for a reader. | *"When you modify authentication, you must do X, never do Y, and verify with Z."* Prescriptive, active, written for an actor. |

Blueprints are **live documents**. They evolve as the team learns, as the architecture shifts, as decisions resolve. The system keeps them honest, see [Drift Detection](#drift-detection).

### What a blueprint covers

Anything that governs how software gets built here and that every contributor, human or AI, needs to respect:

- **Design systems** — component libraries, interaction patterns, accessibility requirements, the visual language of the product
- **Architectural guidelines** — service boundaries, data flow, coupling rules, which layers can call which
- **Security processes** — authentication patterns, secret handling, input validation, audit requirements
- **Operational procedures** — deployment, rollback, observability, on-call expectations
- **Testing conventions** — what to mock, what not to mock, coverage expectations, how to stage test data
- **Code conventions** — naming, structure, error handling, logging. The rules that keep the codebase coherent.

### The five properties of a blueprint

1. **Cross-spec.** A blueprint isn't owned by any one spec. The `deployment` blueprint applies to every spec that ships to production. Blueprints are the shared substrate.
2. **Scoped.** A blueprint has a boundary. "How deployment works" is a blueprint. "Everything about the system" is not. Agents load only the blueprints their work item touches.
3. **Prescriptive.** Blueprints are rule guides and checklists, not explanations. They tell the actor what to do, what to avoid, and how to verify, not why the system exists.
4. **Composable.** A work item might require loading three blueprints simultaneously: `frontend` + `api` + `testing`. The system ensures they don't contradict each other.
5. **Provenance-tracked.** Every rule in every blueprint links back to the decisions that produced it. You can always trace *why* a blueprint says what it says, which decisions set the rule, which incidents shaped it.

### How blueprints fit the lifecycle

Blueprints bookend every piece of work:

1. **Before work starts.** The agent (or human) loads the relevant blueprints for the work item. This is the reference: *how do we build things here?* The execution plan is drafted against these contracts.
2. **During implementation.** Blueprints function as a checklist. If the code being written violates a blueprint rule, the agent stops and raises it. If a blueprint is silent on an edge case that matters, a new decision is logged.
3. **When work ships.** If the implementation changed something the blueprint describes (a deployment step, an auth pattern, an API contract), the blueprint is marked for review.
4. **Over time.** Blueprints evolve. A new decision supersedes an old rule. A production incident tightens a security constraint. The history is preserved, so any rule can be traced to the moment and reason it changed.

### What a blueprint replaces

If you're running AI coding agents today, you almost certainly have `CLAUDE.md`, `cursor rules`, or `.github/copilot` files in your repo. Those are the spiritual predecessors of blueprints. They validate the need, but they're per-repo, per-tool, manually maintained, and disconnected from the decisions that produced them.

**Blueprints are the managed, multi-agent, cross-repository evolution of those files.** The shared contract between every human and every machine working on your codebase.

---

## Humans

### Humans are a first-class primitive

A spec has a purpose. A decision has a resolution. A work item has a goal. A blueprint has a rule. A **human** has a name, a voice, a point of view, and things they've learned that nobody else on the team has.

In Memex, humans aren't implicit, "whoever happens to be logged in". They're an explicit primitive in the graph, connected to every other primitive, with the same first-class treatment as everything else.

A human can:

- **Be @mentioned** in specs, decisions, work items, blueprints, reviews
- **Review and comment** on decision bundles, execution plans, blueprint updates, spec drafts
- **Create** any primitive, specs, decisions, work items, blueprints
- **Develop** — engineers still ship code, designers still design, researchers still investigate
- **Provide input** — taste, judgement, context no agent can reconstruct
- **Make decisions** — the final call on the decisions that matter

### Memex learns who knows what

A software team is not a pool of interchangeable reviewers. Different people hold different parts of the system in their head. One person wrote the auth layer. Another lived through the payments migration. Another owns the design system because they've been refining it for two years. That knowledge is asymmetric, and it matters.

Memex observes the graph over time:

- Who **creates** which specs
- Who **resolves** which kinds of decisions
- Who **writes** and **updates** which blueprints
- Who **reviews** which execution plans
- Whose **comments** tend to catch the issues that matter

From that history, Memex builds a picture of who holds what. When a decision comes up that needs input, when a blueprint needs review, when a work item touches territory only one person really knows, Memex **suggests the right humans** and **reaches out to them directly**.

The team still decides who reviews what. But nobody has to remember *"who was it that fixed the last time we had this problem?"*. The graph remembers.

### The bridge between nameless AI agents and real humans

AI agents are extraordinary at execution. They ship code, draft tests, perform research, and plan migrations at a scale no team could match five years ago. But they are, still, **nameless**. They have no stake in the outcome. They don't remember the incident that shaped the security policy. They don't have the taste that tells them a design is wrong even when it satisfies every requirement.

That's what humans bring, and that's what Memex makes routable.

| AI agents do the work | Humans steward the work |
|-----------------------|------------------------|
| Claim work items, produce execution plans, implement, test, report drift. Fast and high-volume. | Resolve the decisions that matter, approve changes that ship, own the blueprints that govern the whole system. |

Memex is the **routing layer** between them. When an agent needs a decision it can't make, it doesn't stop and wait in silence. It pings the human most likely to have an opinion, with the full context of what's blocked and why. When a blueprint needs updating because the code has drifted, the update request goes to the person who wrote the rule, not to a shared inbox nobody reads.

### This evolution is for all of us

> Our roles in software are evolving. Our humanity is not.

Software engineering is undergoing the most significant shift in a generation. The work isn't disappearing, it's moving. From typing to thinking. From implementation to intent. From executing the plan to shaping the plan.

This is a genuinely exciting transition, and it reframes what it means to be on a software team. The grind is lifting. The tedium is collapsing. What's left is the part that was always the point: **deciding what to build, why it matters, and whether it's any good**.

- **You are the creative driver** — the one who sees the shape of the problem before anyone else.
- **You are the decision maker** — the one who weighs the trade-offs and decides which door the team walks through.
- **You are the steward** — the one who owns the taste, the standard, the craft.
- **You are the chef** — AI is the sharpest knife you've ever worked with. It isn't replacing you. It's elevating you. The dish is still yours.

> **You are not redundant. You are the chef. AI elevates you.**

Memex is built around that belief. Every primitive in the system exists to get AI agents out of your way on the things they're great at, and to get you more sharply focused on the things only you can do.

---

## Drift Detection

### The feature that kills the wiki

Every wiki, every Confluence space, every README in every repository shares the same fate: someone changes the system, doesn't update the docs, and now the docs are actively harmful. This is an unsolvable problem in a human-maintained knowledge base because the maintenance cost is invisible and the consequences are delayed.

In a system where AI agents are both the consumers and producers of knowledge, drift detection becomes possible, and automatic.

### Four ways drift gets detected

1. **Agent-reported drift.** When a coding agent loads a blueprint and discovers the code doesn't match what the blueprint says, it flags the inconsistency. This happens naturally as part of the execution plan step. The flag is a first-class event in the system, not a comment someone might miss.
2. **Decision-triggered review.** When a decision is resolved that affects an existing blueprint, the system marks that blueprint for review. A human or AI agent updates it. Until it's updated, the blueprint carries a staleness warning that agents can see.
3. **Implementation-triggered review.** When a work item is completed that modifies files governed by a blueprint, the system prompts: *"WI-4 modified the deployment pipeline. Blueprint `deployment` may need updating."*
4. **Scheduled audits.** An agent periodically reads each blueprint, compares it against the actual codebase, and reports drift. This is a background operation that runs continuously, not a quarterly documentation review that never happens.

> **The result: institutional knowledge that is current by default, not by heroic effort.**

This is the point Memex AI's bet rests on. If you've ever inherited a codebase with a wiki that lied to you, or joined a team where the onboarding doc referred to a repo that was archived eighteen months ago, you know why.

---

## MCP Architecture

### MCP-native by design

Memex AI exposes its entire surface as an **MCP (Model Context Protocol) server**. Any AI agent, regardless of vendor, framework, or runtime, connects to Memex AI and interacts with the spec/decision/work/blueprint graph through standard tool calls.

This is a deliberate architectural choice. Memex AI is not another AI coding tool. It's the **shared context layer** that all AI tools read from and write to.

### Why MCP

- **Any AI coding agent** (Claude Code, Cursor, GitHub Copilot, custom agents) can connect and access the full graph
- **Multi-vendor, no lock-in** — multiple agents from different vendors share the same context, swap tools without losing your graph
- **Custom agents fit in** — research, testing, deployment, product management, all integrate through the same protocol
- **The server is the source of truth**, not a file in a repository that might be stale

### Core tool surface

```
# Spec (top-level container)
list_specs()                   → all specs with status summary
get_spec(id)                    → purpose, vision, decisions, work items
get_spec_status(id)             → progress overview: open decisions, blocked/ready WIs
promote_work_item(wi_id)            → elevates a WI to its own spec, preserving lineage

# Spec drafting (collaborative design)
create_spec_draft(purpose)               → start a new spec in draft state
update_spec_draft(id, section, content)  → iterative refinement
get_spec_draft(id)                       → current state of the draft, formatted for reading
add_draft_decision(id, question, options)    → surface a design choice during planning
add_draft_work_item(id, goal, deps)          → scope a unit of work
publish_spec(id)                         → move from draft to active; decisions become blockable

# Decisions (within a spec)
get_decision(id)                    → decision with status, options, rationale
get_decisions(spec_id)          → all decisions for a spec
create_decision(spec_id, question, options)
resolve_decision(id, choice, rationale)
reopen_decision(id, reason)         → re-opens a resolved decision, cascades impact
get_decision_impact(id)             → WIs blocked, blueprints affected, cross-spec deps

# Work Items (within a spec)
get_work_item(id)                   → goal, dependencies, checklist, status
get_ready_work_items(spec_id?)  → WIs where all decisions resolved + deps met
check_dependencies(wi_id)           → which are met, which block (within and across specs)
get_dependents(wi_id)               → downstream work this unblocks
update_work_item_status(id, status)
submit_execution_plan(wi_id, plan)
get_execution_plan(wi_id)           → files, dependency flow, conflicts

# Blueprints (cross-cutting knowledge layer)
get_blueprint(domain)                    → full blueprint content
get_blueprints_for_work_item(wi_id)      → which blueprints an agent should load
flag_blueprint_drift(id, evidence)       → "this blueprint says X but code does Y"
get_blueprints_affected_by_decision(id)  → impact analysis before resolving
update_blueprint(id, content, reason)

# Decision extraction (passive capture + review)
extract_decisions(session_context)  → candidate decisions from a conversation
create_decision_bundle(decisions[]) → bundle for review
get_pending_bundles(account_id?)    → bundles awaiting review
review_decision(bundle_id, decision_id, action) → approve | reject | flag
approve_bundle(bundle_id)           → approve all decisions in the bundle
```

### The shape of the integration

Your coding agent connects to the Memex AI MCP server at the start of a session. From that point it can list specs, fetch decisions, check readiness, produce execution plans, and report drift, all through standard MCP tool calls. No custom plugin. No vendor-specific SDK. The agent you're already using gets the spec/decision/work/blueprint graph for free.

---

## Roles

Humans are a first-class primitive in Memex, not "whoever happens to be logged in". Different people bring different expertise, and Memex learns who knows what. Below is how different roles tend to use the graph, but the same person moves fluidly between them in a given week.

### Product & Leadership

**Primary layer:** Specs + Decisions

- Create specs that articulate the objective, the *why*, not just what needs building
- Resolve open decisions that block work
- See the impact of re-prioritisation: *"If we reverse `D4`, which work items are affected and which blueprints become stale?"*
- Track progress through spec completion and decision resolution rate, not story points
- Promote work items to specs when scope expands, keeping the graph honest

### Engineering

**Primary layer:** Work Items + Blueprints

- See what's ready to work on (all decisions resolved, all dependencies met)
- Load relevant blueprints before starting work
- Create execution plans that reconcile design with reality
- Flag drift when blueprints don't match the codebase

### AI Coding Agents

**Primary layer:** Work Items + Blueprints + Decisions

- Load the goal, constraints, and institutional knowledge before writing code
- Check for unresolved blocking decisions and stop rather than guess
- Submit execution plans for review before implementation
- Report blueprint drift when detected during planning
- Update work item status as implementation progresses

### AI Research Agents

**Primary layer:** Decisions

- Investigate open decisions that need data to resolve
- Gather competitive analysis, technical benchmarks, or user research
- Submit findings as evidence attached to specific decisions

### AI Testing Agents

**Primary layer:** Work Items + Blueprints

- Read acceptance criteria from completed work items
- Load testing blueprints (conventions, frameworks, helpers)
- Verify implementations against the stated goals
- Flag when test results contradict blueprint documentation

---

## The Lifecycle

How a piece of work flows through Memex AI:

1. **A Spec is created.** Someone identifies a problem worth solving or an objective worth pursuing. They create a Spec, not a one-line epic title, but the full context. This is the document every decision and work item will trace back to.
2. **Non-obvious design choices surface.** As the spec takes shape, Decisions are logged within it. Each has a stable ID, options with trade-offs, and a status.
3. **Work is scoped.** Work Items are defined within the spec, with goals, acceptance criteria, and explicit dependencies on other work items AND specific decisions.
4. **Decisions are resolved.** Through research, discussion, prototyping, or stakeholder input. Each resolution records the choice, the rationale, and what was rejected. Resolved decisions unblock work items and update affected blueprints.
5. **An agent picks up a work item.** It reads the work item spec, loads relevant blueprints, checks that blocking decisions are resolved, produces an execution plan, and waits for plan review before writing code.
6. **Implementation happens.** The agent executes the plan. If it discovers the code contradicts a blueprint, it flags drift. If a new design question arises, it creates a new decision. When complete, it updates the work item status.
7. **Blueprints update.** Resolved decisions and completed work items trigger blueprint reviews. Blueprints are updated to reflect the current state of the system.
8. **The cycle continues.** New decisions surface. New work items are scoped. Blueprints evolve. The graph grows, but it stays current because the system enforces it.

---

## Building a Spec

### From inside the coding tool

In the old world, planning happens in a separate universe from implementation. Someone opens a Google Doc, writes a spec, shares it in Slack, people comment, it goes through a review cycle, and eventually an engineer reads a half-stale document and starts coding from an incomplete understanding of the intent. The plan and the code never live in the same context.

In an AI-native team, this separation is the root cause of most failures. The agent that implements the work has never seen the conversation that shaped it. The decisions that constrain the implementation are buried in a document the agent can't access.

> **Memex AI eliminates this gap. A spec is built inside the development environment, through conversation, grounded in the actual codebase.**

### The round-trip

You're in your coding tool (Claude Code, Cursor, whatever your team uses). You have an idea, a problem, a direction. You start talking:

> *"I want to add proactive role discovery, help me think through this."*

The agent calls `create_spec_draft()` on the Memex AI MCP server. What follows isn't document generation. It's a **collaborative design session** where you and the agent build the spec together, iteratively, with the codebase as shared context.

**Phase 1: Problem framing.** The agent asks you to articulate the problem. As you talk, the agent reads relevant code. It drafts the purpose statement. You read it back, right there in your terminal, and push back. The purpose sharpens with each pass.

**Phase 2: Decision surfacing.** As the conversation moves to approach, the agent starts recognising non-obvious design choices. *"Should matching run server-side or client-side? There are trade-offs here."* It creates a draft decision with options and trade-offs.

**Phase 3: Work item scoping.** With the purpose clear and the initial decisions logged, the agent proposes work items. It reads the codebase to understand what exists, what needs changing, and what the dependency order should be.

**Phase 4: Blueprint linking.** The agent identifies which existing blueprints are relevant to the work items and whether any new ones are needed.

### Reading it back

At any point, you say *"let me see where we are"* and the agent calls `get_spec_draft()`. The server returns the current state as formatted text, right in your terminal. You read it in context, in the same environment where you'll implement it.

```
$ memex get_spec_draft S3

# S3: Proactive Role Discovery [DRAFT]

## Purpose
Address the horizontal skills mismatch: 34% of graduates work in
the wrong field. Build a system that helps candidates discover
non-obvious role matches based on transferable capabilities.

## Decisions (3 open, 2 resolved)
  D1  How many discovery occupations per candidate    [OPEN]
  D2  Auto-create catchments or require confirmation  [OPEN]
  D3  Profile completeness threshold                  [RESOLVED]
  D4  Location-aware matching                         [RESOLVED]
  D6  Server-side vs client-side matching             [OPEN]

## Work Items (5 scoped)
  WI-1  Discovery matching engine        [depends: strat-002 WI-7]
  WI-2  Profile schema redesign          [no dependencies]
  WI-3  Agent conversation flow          [depends: WI-2, D1, D6]
  WI-4  Discovery tools + integration    [depends: WI-1, WI-2, WI-3]
  WI-5  Outcome tracking                 [depends: WI-4]

## Linked Blueprints
  deployment    [existing, relevant to WI-4]
  testing       [existing, relevant to all WIs]
  matching      [to be created after WI-1]
```

### Publishing

When the spec is solid, you publish it. The agent calls `publish_spec("S3")`. The draft becomes an active spec. Decisions become blockable. Work items become claimable. The system starts tracking what's ready and what's blocked.

The agent that helped you write the spec is the same agent that will pick up `WI-1` and start implementing. It already understands the purpose, the constraints, and the decisions. **There is no handoff.** The spec was built together.

### Why this matters

- **No context switch.** The spec is built where the code lives.
- **No handoff.** The agent that co-authored the spec has full access when it implements.
- **Incremental, not waterfall.** You build the spec through conversation, not as a monolithic document.
- **Grounded in reality.** The agent reads the codebase during planning, so the spec reflects what actually exists.
- **Multiplayer.** The draft lives on the server, not in a local file. Team members contribute concurrently from different environments.

---

## Decision Extraction

### Because nobody will log decisions manually

> Any system that depends on a human remembering to update something will go stale.

Developers don't stop mid-flow to log a decision. They don't pause a productive conversation with their AI agent to open a separate tool and fill in a form. They make the decision, they move on, and the decision is locked in a conversation thread that nobody else will ever read.

This is not a discipline problem. It's a design problem. The system must extract decisions from where they're actually made (in conversation), not demand that people duplicate their thinking into a separate tool.

### Passive extraction with lightweight confirmation

When a developer works with an AI agent through Memex AI's MCP connection, the agent is already participating in decision-making conversations. It knows when a non-obvious choice has been made. It can recognise the shape of a decision: options were considered, trade-offs were weighed, a direction was chosen.

Memex AI extracts these decisions passively. The agent identifies candidate decisions during the conversation and batches them. At natural pause points (end of a session, before a commit, when switching context), the system surfaces what it found.

Extraction is not silent. It produces a **decision bundle**: a batch of decisions from a session, presented for lightweight review before they enter the shared graph.

### Decision bundles — a merge request into the graph

A decision bundle is the unit of review. It's designed to be as easy to process as a code diff, something a reviewer can form an opinion on in two minutes, with full context available if they need to go deeper.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Decision Bundle · 3 decisions · from @sarah · 14:32 today
Spec: S3 — Proactive Role Discovery
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

D12: Use embedding similarity over keyword matching for discovery
  Rationale: Keyword matching misses transferable skills that use
  different vocabulary across industries. Embedding similarity
  captures semantic relatedness.
  Affects: WI-1 (matching engine implementation)
  [Approve]  [Reject]  [Flag for discussion]

D13: Limit initial discovery to 3 occupations per candidate
  Rationale: Showing too many options overwhelms uncertain
  candidates.
  Resolves: D1 (how many discovery occupations)
  [Approve]  [Reject]  [Flag for discussion]

D14: Run matching server-side, not in-browser
  Rationale: Embedding computation is too heavy for client.
  Resolves: D6 (server vs client)
  [Approve]  [Reject]  [Flag for discussion]
```

Each decision has a summary, rationale, impact links, a link to the conversation, and three actions: approve, reject, or flag.

### Why this changes the economics

**Without extraction:** a team of five developers, each making 3–5 decisions per day with their AI agents, produces 15–25 decisions daily that never enter the shared graph. After a month, there are hundreds of invisible decisions. The graph is incomplete by design.

**With extraction:** those same decisions are captured passively, bundled, and reviewed. The graph grows at the rate decisions are actually made, not at the rate humans are willing to do data entry. Review takes minutes per day, not hours. **The graph is complete by default, not by heroic effort.**

---

## Security and Deployment

### Your Memex contains your most sensitive work

The graph Memex holds is, by design, the most valuable and sensitive part of a software organisation. It's where your **strategic direction**, **architectural decisions**, **security processes**, **unreleased product thinking**, and **internal blueprints** all live, connected.

That's the whole point: the graph is how AI agents and humans coordinate without losing context. But it also means that for many teams, what lives in Memex is exactly the kind of information they cannot, or will not, hand to an external SaaS provider.

> We treat this as a first-class design principle, not an enterprise checkbox. **You should never have to choose between getting value from Memex and keeping control of your data.**

### Two ways to run Memex

| Hosted SaaS | Self-hosted |
|-------------|-------------|
| We run it for you. Sign up, connect an agent, start building. The simplest path to getting your team onto Memex. Ideal for teams who want ease-of-use. | The entire Memex system ships as a Docker container. Run it on any virtual server with a Postgres database attached. **100% of your data stays inside your infrastructure.** No outbound calls for your graph, your decisions, or your blueprints. |

Both options expose the same MCP surface, the same UI, and the same features. The only difference is where the data lives.

### Self-hosted, by design

Self-hosting isn't an afterthought or an enterprise-tier gate. It's a core deployment mode with a minimal footprint:

- **One Docker container** — the Memex server ships as a single container. Pull, run, done.
- **One Postgres database** — any Postgres 15+ instance. Bring your own, managed or on-prem.
- **Any virtual server** — a modest VM is enough. No Kubernetes cluster, no service mesh, no dozen-service architecture.
- **No outbound dependencies** — in self-hosted mode, your Memex instance does not call Mindset infrastructure for any core feature.

The only outbound calls a self-hosted Memex makes are the ones **you configure** — to the LLM provider you choose, using the keys you supply.

### Bring your own LLM keys

Memex uses LLMs for decision extraction, drift detection, and the agent-facing tool surface. You control which provider and which keys are used.

- **Your provider, your choice.** Anthropic, OpenAI, Google, a private model in your own VPC, whatever your team has standardised on. Memex is provider-agnostic.
- **Your keys, your billing.** Usage bills to your account, not ours.
- **Your policy, your constraints.** If your compliance team has signed off on a specific provider, Memex uses that provider.
- **Revocable at any time.** Keys live in your configuration, not in Memex's codebase.

### Why we think this matters

Many teams currently treat their project tracker and their wiki as lower-sensitivity systems because, frankly, those systems were never the source of truth for anything that mattered. The decisions lived in people's heads. The spec lived in a Google Doc somebody would revise next quarter.

Memex changes the nature of the artefact. When a tool becomes the authoritative record of what your team has decided, why, and how things are built here, the sensitivity of that tool rises to the level of the codebase itself, or above.

> If your codebase lives in your infrastructure, your Memex should be able to live there too. We've built the product so that's never a trade-off against functionality.

### Choosing between SaaS and self-hosted

**Go SaaS if:** you want the lightest operational footprint, your data policy allows a trusted third-party SaaS, you want upgrades and new features to land automatically, you'd rather focus on using Memex than running it.

**Go self-hosted if:** your data cannot leave your infrastructure, you have compliance requirements that mandate internal hosting (SOC 2 boundaries, GDPR residency, sector-specific regulations), you already run Postgres and Docker, your security team wants to own the threat model end to end.

You can start on SaaS and migrate to self-hosted later, or vice versa. The graph is portable, it's just Postgres.

---

## Why Not Just Use Existing Tools?

### "We already have Jira / Linear / Shortcut"

These tools manage work assignment and status tracking. They're good at answering *"who's doing what?"* They're not designed to answer *"what did we decide and why?"* or *"what does an agent need to know before touching this part of the system?"* Decisions live in ticket comments. Knowledge lives in a separate wiki. There's no enforced link between them.

**Memex AI doesn't necessarily replace your project tracker.** It's the layer underneath it, the decision and knowledge substrate that gives every ticket its context.

### "We already have Confluence / Notion / a wiki"

Wikis are where knowledge goes to die. They're write-once, read-never, maintained-by-nobody. They have no concept of staleness, no drift detection, no link to the decisions that produced them, and no awareness of whether the code still matches what they describe.

**Memex AI blueprints are not pages.** They're living documents with provenance, scope, and automated freshness guarantees.

### "We already have CLAUDE.md / cursor rules / .github/copilot"

These are the closest precursors to what Memex AI provides, and they validate the need. But they're per-repo, per-tool, and manually maintained. They don't connect to decisions. They don't track dependencies. They don't detect drift. They're a prototype of the blueprints layer without the decision layer or the coordination layer.

**Memex AI is the managed, multi-agent, cross-repository evolution of these files.**

### "We'll just put everything in the repo"

Many teams try this. Spec docs in `/docs`, ADRs in `/decisions`, conventions in `CONTRIBUTING.md`. It works for small teams with one repo. It breaks when:

- You have multiple repositories that share architectural decisions
- Multiple agents need to coordinate across repos
- Documents drift from reality and nobody notices
- A decision in one repo affects work in another

---

## Before and After

### Before Memex AI

- Decisions are scattered across Slack, tickets, meeting notes, and memory
- An AI agent picks up a ticket, reads a stale wiki page, and builds the wrong thing
- Two agents work on related features without knowing about each other's constraints
- A new team member spends two weeks absorbing tribal knowledge
- Re-prioritisation is chaotic because nobody can trace the decision graph
- Documentation is always wrong, and everyone knows it, and nobody fixes it

### After Memex AI

- Every initiative has a Spec that articulates the objective, the context that makes every decision and work item intelligible
- Every decision has an ID, a status, a rationale, and explicit links to the work it affects, all traceable back to the spec that spawned it
- An AI agent reads the spec, the decision graph, and relevant blueprints before writing code, and stops if something is unresolved
- Agents coordinate through a shared context layer, not through hope
- A new team member (human or AI) loads the spec and relevant blueprints and starts contributing immediately
- Re-prioritisation is a graph operation: reverse `D4`, see the cascade across the spec, make an informed choice
- Institutional knowledge stays current because the system detects when it drifts
- Humans with the right expertise are routed to the right decisions automatically
- Your data stays where your security policy says it has to stay

---

## The Core Bet

### The bottleneck keeps shifting

The history of software tooling follows the bottleneck:

1. **Compilation** — when the bottleneck was compilation, we built better compilers.
2. **Integration** — when it was integration, we built CI/CD.
3. **Communication** — when it was communication, we built agile and Scrum.
4. **Deployment** — when it was deployment, we built Kubernetes and infrastructure-as-code.
5. **Spec & decisions** — AI agents have made implementation fast and cheap. The new bottleneck is articulating what we're trying to achieve, resolving the ambiguity that blocks progress, and ensuring every agent and every human in the system acts on the current set of decisions with the current institutional knowledge.

> **Memex AI is the tool for this new bottleneck.** Not another project tracker. Not another wiki. Not another AI coding assistant. The spec, decision, and knowledge layer that makes all of them coherent.

### A note from us

We run Mindset on a set of mental models that take bottlenecks seriously. We use the Theorem of Constraints to identify the slowest interconnected part of any process and attack it first. For most AI-assisted engineering teams right now, that part is decisions: capturing them, propagating them, and keeping institutional knowledge honest.

If you've read this far, you already know whether it's your bottleneck too.

---

## Getting Started / Early Access

### Be an early adopter

Memex AI is in the hands of a small group of teams right now, Mindset being one of them. We're not in full release yet, and we're not pretending otherwise.

If the rest of this whitepaper resonates, we'd love to have you with us on the journey. We're looking for teams who are already feeling the bottleneck, already experimenting with AI-native ways of working, already impatient with tools that don't match the shape of the work anymore.

### What "early adopter" actually means

- **Shape the product.** You'll have direct access to the team building it. Features you need get prioritised. Things that don't work, we fix. Your feedback is the roadmap.
- **Share what you learn.** Early adopters form a small community of teams figuring out AI-native engineering together. We learn faster when we learn in the open.
- **Get support from us.** We help you set up, connect your first agent, draft your first spec, and work through the inevitable rough edges of a product that's still finding its final form.
- **Keep pace with the shift.** Software engineering is changing faster than at any point in the last twenty years. Being early isn't just a product status, it's a posture.

### Join the waitlist

> **[memex.ai](https://memex.ai/)** — request early access.

Both SaaS and self-hosted deployment modes are available to early adopters. Bring your own LLM keys. Run it where your data is allowed to live.

---

*Memex AI: because the hardest part of building software was never writing the code.*

*A whitepaper from [Mindset AI](https://mindset.ai). We believe in full transparency — if any of this feels off, tell us.*
