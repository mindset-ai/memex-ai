# memex.ai

## The Decision Layer for AI-Native Software Teams

> **Naming:** this whitepaper originally used **Mission** throughout. The user-facing noun was then renamed to **Brief** (doc-26 rename), and finally to **Spec** (b-105, May 2026). This file has been updated in place — every occurrence below now reads **Spec** / **Specs** and every `*_mission` MCP tool now reads as the equivalent `*_spec` tool (`assess_spec`, `publish_spec`, etc.). The prose is otherwise left intact so the historical argument still reads coherently.

---

### Your AI agents are brilliant. They're also building the wrong thing.

Every day, AI coding agents ship thousands of lines of code across your organisation. They're fast, tireless, and increasingly capable. But ask yourself: how does Agent A know what Agent B decided yesterday? How does the agent refactoring your authentication module know that the team resolved — three weeks ago — to migrate away from JWTs? How does the agent writing your deployment script know that staging now requires a VPN, because someone changed the infrastructure last Tuesday and never updated the docs?

It doesn't. And neither does the new developer who joined on Monday.

**The bottleneck in modern software development is no longer writing code. It's making decisions — and making sure everyone (human and machine) knows what was decided, why, and what it means for the work ahead.**

memex.ai is the spec, decision, and knowledge layer purpose-built for teams where AI agents do the implementation work. It replaces the agile artifact hierarchy — epics, stories, tasks — with a structure that reflects how software actually gets built today: through Specs that articulate the objective end-to-end, decisions that resolve ambiguity along the way, work items that agents can execute, and institutional knowledge that stays current because the system won't let it rot.

---

## The Problem

### The world moved on. The tools didn't.

Agile project management was designed in 2001 for teams of humans who needed work broken into predictable, estimable chunks. The artifact hierarchy — **Epic → Story → Task → Subtask** — is a communication protocol between people sitting in the same room, negotiating scope at a whiteboard.

Twenty-five years later:

- AI agents write production code, generate tests, perform research, and handle deployments
- Teams are distributed across time zones, and "the room" is a Slack thread
- The rate of change has outpaced any human's ability to maintain a mental model of the system
- Decisions that once lived in someone's head now need to be machine-readable

Yet we're still forcing this reality into tools built for a different era. We write stories for agents that don't need narrative. We estimate points for work that takes minutes. We maintain wikis that are wrong by the time they're published.

**The result is predictable: AI agents produce incoherent work because they lack shared context.**

---

### Three failures that compound daily

**1. Decisions are invisible — in both directions.**

In every existing project management tool, a decision is a comment buried in a ticket, a message lost in a Slack channel, or a vague memory from last month's planning session. There is no canonical place where "we decided X because of Y" lives as a first-class, referenceable object.

But the problem is now bidirectional. The old failure mode was human decisions not reaching agents. The new failure mode — and it's already happening in every team using AI tools — is that **decisions made during human-AI conversations don't reach other humans or their agents.**

A developer spends an hour with their AI agent working through an architectural problem. They explore options, weigh trade-offs, and arrive at a decision. That decision is now locked in a conversation thread that nobody else can see. The next developer working on a related feature has no idea the decision was made. Their agent has no idea either. Two people made two contradictory decisions, each with their own AI agent, in two separate conversations, on the same Tuesday afternoon.

This is the new shape of invisible decisions. They're not buried in Slack or lost in meeting notes. They're **locked in AI conversation threads** — and the volume is growing because human-AI planning sessions are now where most design thinking happens.

When priorities shift — and they always shift — teams can't trace which decisions are affected, which work items depend on them, or what downstream consequences follow. Re-prioritisation becomes chaos because the decision graph was never explicit.

*A developer's AI agent picks up a ticket to build a caching layer. It doesn't know the team decided last week to move from Redis to Valkey. It builds the Redis implementation. The PR gets rejected. The agent's work is wasted. The developer's afternoon is wasted reviewing code that should never have been written.*

**2. Institutional knowledge decays.**

Every team has accumulated knowledge about how things work: deployment procedures, coding conventions, architectural boundaries, security requirements, design principles. This knowledge lives in READMEs that were accurate six months ago, in wiki pages nobody maintains, and in the heads of senior engineers who haven't updated the onboarding docs since they were onboarded themselves.

For human developers, this is friction. For AI agents, it's fatal. An agent doesn't have tribal knowledge. It can't ask the person sitting next to it. When it loads a stale document that says "deploy with `kubectl apply`" but the team moved to ArgoCD three sprints ago, the agent follows the document. Confidently. Incorrectly.

*The testing conventions document says to mock the database. The team stopped doing that after a production incident where mocked tests passed but the real migration failed. A new AI agent reads the document, mocks the database, writes tests that pass against the mock, and the team ships a broken migration. Again.*

**3. No coordination between agents.**

When two AI agents work on related parts of a system simultaneously — and this is increasingly common — there is no mechanism for them to share context. Agent A modifies a shared interface. Agent B, working from an outdated understanding of that interface, produces code that won't compile. Neither agent knows the other exists.

This isn't a hypothetical. It's happening right now in every team running multiple AI agents against a shared codebase. The agents are individually competent and collectively incoherent.

---

### The cost is staggering — and hidden

These failures don't show up as a line item. They show up as:

- PRs that get rejected because the agent didn't know about a recent decision
- Duplicated work when two agents solve the same problem differently
- Debugging sessions caused by stale documentation
- Onboarding time for new team members (human or AI) that stretches from days to weeks
- The slow, invisible drift of a codebase away from its own architectural principles

**What if the system that held your decisions, your work, and your institutional knowledge was the same system your AI agents read from before writing a single line of code?**

---

## The Solution

### memex.ai — Decisions, Work, and Knowledge in One Graph

memex.ai is built on a simple structural insight: in an AI-native development team, there are four types of information that matter, and they form a hierarchy.

```
┌─────────────────────────────────────────────────┐
│  SPEC                 (the objective)            │
│  What we're trying to achieve and why.           │
│  The market problem, the vision, the principles. │
│  Every Spec spawns decisions and work.            │
├─────────────────────────────────────────────────┤
│  DECISIONS            (the leading edge)         │
│  What we're figuring out. Open questions,        │
│  options, resolutions with rationale.            │
│  Each belongs to a Spec.                         │
│  Drives prioritisation and unblocks work.        │
├─────────────────────────────────────────────────┤
│  WORK ITEMS           (the work graph)           │
│  What needs doing. Goals, dependencies,          │
│  acceptance criteria, execution plans.           │
│  Each belongs to a Spec.                         │
│  Agents claim, plan, and execute.                │
├─────────────────────────────────────────────────┤
│  PLAYBOOKS            (the trailing edge)         │
│  What we know. How things work here.             │
│  Deployment, conventions, architecture,          │
│  security, design principles.                    │
│  Updated when decisions resolve or code changes. │
│  Drift-detected automatically.                   │
└─────────────────────────────────────────────────┘
```

These four layers are connected by explicit, traceable links:

- **Specs** contain **Decisions** and **Work Items** — they're the organising boundary
- **Decisions** block or unblock **Work Items** within (and sometimes across) Specs
- **Resolved Decisions** crystallise into **Blueprints** (institutional knowledge)
- **Blueprints** inform how **Work Items** are executed
- **Completed Work Items** may surface new **Decisions**
- **Implementation changes** trigger **Blueprint reviews**
- **Work Items** that outgrow their scope get **promoted to their own Spec**

This isn't four separate tools stitched together. It's one graph. The Spec is the container that gives decisions and work items their purpose, end to end — from the goal that motivated the work to the outcome that closes the loop. Decisions are the leading edge (what we're figuring out). Blueprints are the trailing edge (what we've figured out). Work items connect them.

---

## Core Concepts

### Specs — The Container for Everything

A **Spec** is the top-level construct in memex.ai. It represents an objective the team is trying to achieve — a product initiative, an architectural migration, a platform capability, a compliance requirement — and carries that objective end-to-end, from intent through execution to validated outcome. It's the answer to "why are we doing any of this work?" and also "did we actually do it?"

A Spec contains:

- **A purpose statement** — the problem or opportunity, in enough depth that anyone (human or AI) can understand the motivation without a briefing
- **The architectural vision** — how the solution fits into the broader system, what principles guide it
- **Decisions** — the non-obvious design choices that must be resolved to move forward
- **Work Items** — the scoped units of implementation, linked to decisions and to each other

Specs are the boundary that prevents context from sprawling. When an agent picks up a work item, it loads the Spec that contains it — not the entire organisational knowledge base. A team might have five active Specs. Each is self-contained: its own decisions, its own work items, its own dependency graph. Each is also closed-loop: a Spec isn't "done" because its tasks finished — it's done when the outcome has been checked against the original intent.

**The promotion path.** Work sometimes outgrows its container. A work item scoped as "add a caching layer" might reveal a design problem with its own market context, architectural trade-offs, and multiple sub-work-items. When this happens, the work item is **promoted** to its own Spec. The link to the parent Spec is preserved — you can always trace how a Spec was born.

**Cross-Spec dependencies.** Specs are self-contained but not isolated. A work item in Spec B might depend on infrastructure delivered by Spec A. These cross-Spec links are explicit and tracked. When Spec A's work item ships, Spec B's blocked items are automatically unblocked.

**Why this matters:** Without a Spec, decisions and work items are just a flat list. The Spec provides the *why* that makes every decision intelligible and every work item purposeful, *and* the *did-we* that makes "complete" mean something. It's the difference between "we decided to use PostgreSQL" (arbitrary) and "we decided to use PostgreSQL because our discovery matching engine needs pgvector for embedding similarity, and the Spec requires sub-100ms lookups across 3,000 occupation vectors" (traceable to a goal).

In the old world, this was an Epic. But an Epic is a label on a group of tickets — it ends when the tickets close. A Spec is a living document that holds the reasoning, the open questions, the architectural context that every agent needs before touching the code, and the outcome check that confirms the work actually delivered the goal.

---

### Decisions — First-Class, Not Afterthoughts

In memex.ai, every non-obvious design choice is a **Decision** with:

- **A stable ID** (D1, D2, ...) — referenceable from any work item, blueprint, or conversation
- **Status** — Open, Leaning, Resolved
- **Options** — the plausible alternatives, with trade-offs
- **Resolution** — what was chosen, why, and what was rejected
- **Impact links** — which work items are blocked, which blueprints are affected

Decisions are not documentation. They are **active objects in the system.** An open decision is a blocker. A resolved decision is a constraint. When priorities change, you re-open and re-resolve decisions — and the system traces the downstream impact automatically.

**Why this matters for AI agents:** An agent asked to implement a caching layer checks memex.ai first. It sees Decision D7: "Cache invalidation approach" is still open with three options under consideration. The agent *stops and reports this* rather than guessing. The team resolves D7, and every agent working on related features immediately has the answer.

**Why this matters for humans:** When a stakeholder asks "why did we build it this way?", the answer isn't buried in a Slack thread from four months ago. It's Decision D7, resolved on March 3rd, with the full rationale and rejected alternatives preserved.

---

### Work Items — A Dependency Graph, Not a Backlog

Work Items in memex.ai are not stories. They don't have estimation points, acceptance criteria written as "As a user, I want...", or sprint assignments. They have:

- **A Goal** — one sentence describing what it achieves
- **Dependencies** — explicit links to other work items AND unresolved decisions that block it
- **Acceptance Criteria** — concrete, testable checklist
- **Status** — Not Started, Blocked (with reason), In Progress, Complete

Work Items form a **directed acyclic graph (DAG)**, not a flat backlog. WI-4 depends on WI-1, WI-2, and WI-3. It also depends on Decisions D5 and D9 being resolved. The system knows this and can answer the question every team asks constantly: **"What can we actually work on right now?"**

```
get_ready_work_items() →
  WI-2: Profile schema redesign     [all dependencies met]
  WI-6: Teleworkability enrichment   [all dependencies met]

  Blocked:
  WI-3: Agent conversation flow      [waiting on D7, D8]
  WI-4: Discovery integration        [waiting on WI-1, WI-3]
```

**The Execution Plan gate.** Before an agent writes code for a work item, it must produce an **Execution Plan** — a reconciliation of the work item's requirements against the actual codebase. The plan lists files to modify, dependency flow, and conflicts found between the design and reality. These conflicts *always* exist. The execution plan is where they surface, before they become bugs.

No coding happens until the execution plan is reviewed. This is the single most effective quality gate for AI agents, because it forces the agent to ground its understanding in the actual code rather than hallucinating an implementation from the specification alone.

---

### Blueprints — Institutional Knowledge That Can't Rot

A Blueprint is a **scoped bundle of context** that an agent loads when it needs to operate in a specific domain. It is not documentation. It is instructions for an actor.

Documentation says: *"Here's how authentication works."*
A Blueprint says: *"When you modify authentication, you must do X, never do Y, and verify with Z."*

Blueprints have properties that distinguish them from wikis and READMEs:

**Scoped.** A blueprint has a boundary. "How deployment works" is a blueprint. "Everything about the system" is not. When an agent picks up a work item that touches deployment, it loads the deployment blueprint — not every blueprint in the system.

**Prescriptive.** Blueprints contain instructions, constraints, and conventions — not explanations. They're written for the entity that will do the work (increasingly, an AI agent), not for a reader trying to understand the system.

**Composable.** A work item might require loading three blueprints simultaneously: `frontend` + `api` + `testing`. The system ensures they don't contradict each other.

**Provenance-tracked.** Every blueprint links back to the decisions that produced it. When Decision D14 resolved "use subcollections for profile storage," that resolution updated the `data-model` blueprint automatically. You can always trace *why* a blueprint says what it says.

**Drift-detected.** This is the critical differentiator. Blueprints don't rot because the system actively prevents it.

---

### Drift Detection — The Feature That Kills the Wiki

Every wiki, every Confluence space, every README in every repository shares the same fate: someone changes the system, doesn't update the docs, and now the docs are actively harmful. This is an unsolvable problem in a human-maintained knowledge base because the maintenance cost is invisible and the consequences are delayed.

In a system where AI agents are both the consumers and producers of knowledge, drift detection becomes possible — and automatic.

**Agent-reported drift.** When a coding agent loads a blueprint and discovers the code doesn't match what the blueprint says, it flags the inconsistency. This happens naturally as part of the execution plan step. The flag is a first-class event in the system, not a comment someone might miss.

**Decision-triggered review.** When a decision is resolved that affects an existing blueprint, the system marks that blueprint for review. A human or AI agent updates it. Until it's updated, the blueprint carries a staleness warning that agents can see.

**Implementation-triggered review.** When a work item is completed that modifies files governed by a blueprint, the system prompts: "WI-4 modified the deployment pipeline. Blueprint `deployment` may need updating."

**Scheduled audits.** An agent periodically reads each blueprint, compares it against the actual codebase, and reports drift. This is a background operation that runs continuously, not a quarterly documentation review that never happens.

**The result: institutional knowledge that is current by default, not by heroic effort.**

---

## Architecture — MCP-Native

memex.ai exposes its entire surface as an **MCP (Model Context Protocol) server**. Any AI agent — regardless of vendor, framework, or runtime — connects to memex.ai and interacts with the Spec/decision/work/blueprint graph through standard tool calls.

This is a deliberate architectural choice. memex.ai is not another AI coding tool. It's the **shared context layer** that all AI tools read from and write to.

### Core Tool Surface

```
# Spec (top-level container)
list_specs()                     → all Specs with status summary
get_spec(id)                     → purpose, vision, decisions, work items
get_spec_status(id)              → progress overview: open decisions, blocked/ready WIs
promote_work_item(wi_id)            → elevates a WI to its own Spec, preserving lineage

# Spec drafting (collaborative design)
create_spec_draft(purpose)       → start a new Spec in draft state
update_spec_draft(id, section, content) → iterative refinement
get_spec_draft(id)               → current state of the draft, formatted for reading
add_draft_decision(id, question, options)   → surface a design choice during planning
add_draft_work_item(id, goal, deps)         → scope a unit of work
publish_spec(id)                 → move from draft to active — decisions become blockable

# Decisions (within a Spec)
get_decision(id)                    → decision with status, options, rationale
get_decisions(spec_id)           → all decisions for a Spec
create_decision(spec_id, question, options)
resolve_decision(id, choice, rationale)
reopen_decision(id, reason)         → re-opens a resolved decision, cascades impact
get_decision_impact(id)             → WIs blocked, blueprints affected, cross-Spec deps

# Work Items (within a Spec)
get_work_item(id)                   → goal, dependencies, checklist, status
get_ready_work_items(spec_id?)   → WIs where all decisions resolved + deps met
check_dependencies(wi_id)           → which are met, which block (within and across Specs)
get_dependents(wi_id)               → downstream work this unblocks
update_work_item_status(id, status)
submit_execution_plan(wi_id, plan)
get_execution_plan(wi_id)           → files, dependency flow, conflicts

# Blueprints (cross-cutting knowledge layer)
get_blueprint(domain)                → full blueprint content
get_blueprints_for_work_item(wi_id)  → which blueprints an agent should load
flag_blueprint_drift(id, evidence)   → "this blueprint says X but code does Y"
get_blueprints_affected_by_decision(id) → impact analysis before resolving
update_blueprint(id, content, reason)

# Decision extraction (passive capture + review)
extract_decisions(session_context)  → candidate decisions from a conversation
create_decision_bundle(decisions[]) → bundle for review
get_pending_bundles(account_id?)    → bundles awaiting review
review_decision(bundle_id, decision_id, action) → approve | reject | flag
approve_bundle(bundle_id)           → approve all decisions in the bundle
```

### Why MCP?

MCP is becoming the standard protocol for AI tool integration. By exposing memex.ai as an MCP server:

- **Any AI coding agent** (Claude Code, Cursor, GitHub Copilot, custom agents) can connect and access the full Spec/decision/work/blueprint graph
- **Multiple agents from different vendors** share the same context without vendor lock-in
- **Custom agents** (research agents, testing agents, deployment agents, product management agents) integrate through the same protocol
- **The server is the source of truth**, not a file in a repository that might be stale

---

## Role-Based Interaction

Different people in the software development lifecycle interact with different layers of the graph — but it's the same graph.

### Product & Leadership
**Primary layer:** Specs + Decisions

- Create Specs that articulate the objective — the *why* — not just what needs building
- Resolve open decisions that block work
- See the impact of re-prioritisation: "If we reverse Decision D4, which work items are affected and which blueprints become stale?"
- Track progress through Spec completion and decision resolution rate, not story points
- Promote work items to Specs when scope expands, keeping the graph honest

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

### How a piece of work flows through memex.ai

**1. A Spec is created.**
Someone identifies a problem worth solving or an objective worth pursuing. They create a **Spec** — not a one-line epic title, but the full context: what's the problem, who does it affect, what does the solution look like architecturally, what principles should guide the work, and what does success look like when we're done. This is the document that every decision and every work item will trace back to. Without it, agents are building features. With it, they're solving a problem.

**2. Non-obvious design choices surface.**
As the Spec takes shape, **Decisions** are logged within it. Each has a stable ID, options with trade-offs, and a status. Some are resolved quickly; others require research, prototyping, or stakeholder alignment. The Spec gives each decision its context — "D7: Cache invalidation approach" is meaningless alone, but within the Spec it's clear *why* this choice matters and *what's at stake*.

**3. Work is scoped.**
**Work Items** are defined within the Spec, with goals, acceptance criteria, and explicit dependencies on other work items AND specific decisions. The dependency graph makes it clear what can start now and what's blocked. Every work item inherits the Spec's context — an agent loading WI-3 can always navigate up to the Spec to understand the broader objective.

**4. Decisions are resolved.**
Through research, discussion, prototyping, or stakeholder input, decisions get resolved. Each resolution records the choice, the rationale, and what was rejected. Resolved decisions unblock work items and update affected blueprints.

**5. An agent picks up a work item.**
The agent connects via MCP and:
- Reads the work item spec (goal, dependencies, checklist)
- Loads all relevant blueprints (deployment, conventions, architecture)
- Checks that all blocking decisions are resolved
- Produces an execution plan reconciling the spec against the actual codebase
- Waits for plan review before writing code

**6. Implementation happens.**
The agent executes the plan. If it discovers the code contradicts a blueprint, it flags drift. If a new design question arises, it creates a new decision. When complete, it updates the work item status.

**7. Blueprints update.**
Resolved decisions and completed work items trigger blueprint reviews. Blueprints are updated to reflect the current state of the system. Drift detection runs continuously.

**8. The cycle continues.**
New decisions surface. New work items are scoped. Blueprints evolve. The graph grows, but it stays current because the system enforces it.

---

## Building a Spec — From Inside the Coding Tool

### The old way to plan

In the old world, planning happens in a separate universe from implementation. Someone opens a Google Doc, writes a spec, shares it in Slack, people comment, it goes through a review cycle, and eventually an engineer reads a half-stale document and starts coding from an incomplete understanding of the intent. The plan and the code never live in the same context.

In an AI-native team, this separation is the root cause of most failures. The agent that implements the work has never seen the conversation that shaped it. The decisions that constrain the implementation are buried in a document the agent can't access. The codebase context that should inform the Spec is invisible to the person writing it.

memex.ai eliminates this gap. **A Spec is built inside the development environment, through conversation, grounded in the actual codebase.**

### The round-trip

You're in your coding tool — Claude Code, Cursor, whatever your team uses. You have an idea, a problem, a direction. You start talking:

> "I want to add proactive role discovery — help me think through this."

The agent calls `create_spec_draft()` on the memex.ai MCP server. What follows isn't document generation — it's a **collaborative design session** where you and the agent build the Spec together, iteratively, with the codebase as shared context.

**Phase 1: Problem framing.**
The agent asks you to articulate the problem. What's broken? Who's affected? What does success look like? As you talk, the agent reads relevant code to understand the current state of the system. It drafts the purpose statement. You read it back — right there in your terminal — and push back. "No, the problem isn't X, it's Y." The agent updates. You go around again. The purpose sharpens with each pass.

**Phase 2: Decision surfacing.**
As the conversation moves to approach, the agent starts recognising non-obvious design choices. "Should matching run server-side or client-side? There are trade-offs here." It creates a draft decision with options and trade-offs. You might say "that's not a decision, that's obvious — go with server-side" and the agent resolves it immediately. Or you might say "add an option C — hybrid approach" and the decision stays open for further research.

The decisions emerge from the conversation. They're not invented in a vacuum or listed speculatively — they surface because the agent is reasoning about the Spec against the actual architecture.

**Phase 3: Work item scoping.**
With the purpose clear and the initial decisions logged, the agent proposes work items. It reads the codebase to understand what exists, what needs changing, and what the dependency order should be. It drafts WI-1 through WI-N with goals, acceptance criteria, and dependencies — including dependencies on the unresolved decisions from Phase 2.

You review. "WI-3 is too big, split it." "WI-5 depends on WI-2, not WI-1." "Add a work item for the migration — you missed that." The agent updates the draft in real time.

**Phase 4: Blueprint linking.**
The agent identifies which existing blueprints are relevant to the work items and whether any new ones are needed. "WI-4 will touch the deployment pipeline — the `deployment` blueprint should be loaded when that work starts. There's no `matching-engine` blueprint yet — we'll need to create one after WI-1 is implemented."

### Reading it back

At any point, you say "let me see where we are" and the agent calls `get_spec_draft()`. The server returns the current state — purpose, decisions, work items, linked blueprints — as formatted text, right in your terminal. You read it in context, in the same environment where you'll implement it. No context switch. No browser tab. No separate app.

```
$ memex get_spec_draft M3

# M3: Proactive Role Discovery [DRAFT]

## Purpose
Address the horizontal skills mismatch — 34% of graduates work in
the wrong field. Build a system that helps candidates discover
non-obvious role matches based on transferable capabilities.

## Decisions (3 open, 2 resolved)
  D1  How many discovery occupations per candidate    [OPEN]
  D2  Auto-create catchments or require confirmation  [OPEN]
  D3  Profile completeness threshold                  [RESOLVED → extraction utility opines]
  D4  Location-aware matching                         [RESOLVED → yes, using TTWA data]
  D6  Server-side vs client-side matching             [OPEN]

## Work Items (5 scoped)
  WI-1  Discovery matching engine        [depends: M2 WI-7]
  WI-2  Profile schema redesign          [no dependencies]
  WI-3  Agent conversation flow          [depends: WI-2, D1, D6]
  WI-4  Discovery tools + integration    [depends: WI-1, WI-2, WI-3]
  WI-5  Outcome tracking                 [depends: WI-4]

## Linked Blueprints
  deployment    [existing, relevant to WI-4]
  testing       [existing, relevant to all WIs]
  matching      [to be created after WI-1]
```

You scan it, spot a gap, say "we need a decision about how to handle candidates with thin profiles", the agent adds D7, links it as a blocker on WI-3, and the draft updates.

### Publishing

When the Spec is solid — purpose is clear, key decisions are logged, work items are scoped with dependencies — you publish it:

> "This looks good. Publish it."

The agent calls `publish_spec("M3")`. The draft becomes an active Spec. Decisions become blockable. Work items become claimable. The system starts tracking what's ready and what's blocked.

The agent that helped you write the Spec is the same agent — or at least, an agent with access to the same MCP server — that will pick up WI-1 and start implementing. It already understands the purpose, the constraints, and the decisions. There is no handoff. There is no "let me read the spec." The spec was built together.

### Why this matters

**No context switch.** The Spec is built where the code lives. The agent reads the codebase while helping you plan. You never leave your development environment.

**No handoff.** The agent that co-authored the Spec has full access to the same Spec when it implements. Decisions and constraints don't get lost in translation.

**Incremental, not waterfall.** You don't write a complete Spec document and hand it over. You build it through conversation — problem first, then decisions, then work items. Each round refines the previous. You can publish with three work items and add more later.

**Grounded in reality.** Because the agent reads the codebase during planning, the Spec reflects what actually exists — not what someone remembered from last quarter. Work items reference real files and real dependencies, not abstract components.

**Multiplayer.** The draft lives on the memex.ai server, not in a local file. Another team member can open their own coding tool, connect to the same MCP server, read the draft, and contribute their own decisions or work items. Two people can shape a Spec concurrently from different environments.

---

## Decision Extraction — Because Nobody Will Log Them Manually

### The logging problem

Everything described so far assumes decisions make it into the graph. But here's the uncomfortable truth: **any system that depends on a human remembering to update something will go stale.**

Developers don't stop mid-flow to log a decision. They don't pause a productive conversation with their AI agent to open a separate tool and fill in a form. They make the decision, they move on, and the decision is locked in a conversation thread that nobody else will ever read.

This is not a discipline problem. It's a design problem. The system must extract decisions from where they're actually made — in conversation — not demand that people duplicate their thinking into a separate tool.

### Passive extraction with lightweight confirmation

When a developer works with an AI agent through memex.ai's MCP connection, the agent is already participating in decision-making conversations. It knows when a non-obvious choice has been made. It can recognise the shape of a decision: options were considered, trade-offs were weighed, a direction was chosen.

memex.ai extracts these decisions passively. The agent identifies candidate decisions during the conversation and batches them. The developer doesn't need to do anything differently — they just work. At natural pause points (end of a session, before a commit, when switching context), the system surfaces what it found.

The extraction is not silent. It's not a background process that quietly populates the graph without anyone knowing. That would create a different trust problem. Instead, it produces a **decision bundle** — a batch of decisions from a session, presented for lightweight review before they enter the shared graph.

### Decision bundles — a merge request into the graph

A decision bundle is the unit of review. It's designed to be as easy to process as a code diff — something a reviewer can form an opinion on in two minutes, with full context available if they need to go deeper.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Decision Bundle · 3 decisions · from @sarah · 14:32 today
Spec: M3 — Proactive Role Discovery
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

D12: Use embedding similarity over keyword matching for discovery
  Rationale: Keyword matching misses transferable skills that use
  different vocabulary across industries. Embedding similarity
  captures semantic relatedness.
  Affects: WI-1 (matching engine implementation)
  [Approve]  [Reject]  [Flag for discussion]
  ↳ View conversation context

D13: Limit initial discovery to 3 occupations per candidate
  Rationale: Showing too many options overwhelms uncertain
  candidates. The agent can offer more if the candidate engages.
  Resolves: D1 (how many discovery occupations)
  [Approve]  [Reject]  [Flag for discussion]
  ↳ View conversation context

D14: Run matching server-side, not in-browser
  Rationale: Embedding computation is too heavy for client.
  Server-side also enables caching across candidates with
  similar profiles.
  Resolves: D6 (server vs client)
  [Approve]  [Reject]  [Flag for discussion]
  ↳ View conversation context

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Approve all]  [Review individually]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Each decision in the bundle has:

- **A summary** — one sentence, enough to understand the choice
- **The rationale** — why this option, compressed to the essential reasoning
- **Impact links** — which work items and existing decisions are affected
- **A link back to the conversation** — the full context, available but not required for review
- **Three actions** — approve (enters the graph), reject (discarded with reason), or flag (needs team discussion)

### Progressive disclosure

The bundle is designed around progressive disclosure. The default view shows the summary and rationale — enough to form an opinion in seconds. If a decision looks surprising or consequential, the reviewer clicks through to the conversation context. Most decisions won't need this. The ones that do are exactly the ones that benefit from it.

This mirrors how code review works. You scan the diff. Most changes are obvious. A few need closer inspection. The tool makes scanning fast and deep-diving possible — it doesn't force you to read every line of every file.

### Why this changes the economics

Without extraction: a team of five developers, each making 3-5 decisions per day with their AI agents, produces 15-25 decisions daily that never enter the shared graph. After a month, there are hundreds of invisible decisions. The graph is incomplete by design, because it only contains what someone remembered to log.

With extraction: those same decisions are captured passively, bundled, and reviewed. The graph grows at the rate decisions are actually made, not at the rate humans are willing to do data entry. Review takes minutes per day, not hours. The graph is complete by default, not by heroic effort.

### The MCP tools

```
# Extraction
extract_decisions(session_context)  → candidate decisions from a conversation
create_decision_bundle(decisions[]) → bundle for review

# Review
get_pending_bundles(account_id)     → bundles awaiting review
review_decision(bundle_id, decision_id, action, reason?)
  action: approve | reject | flag
approve_bundle(bundle_id)           → approve all decisions in the bundle
```

---

## Why Not Just Use [Existing Tool]?

### "We already have Jira / Linear / Shortcut"

These tools manage work assignment and status tracking. They're good at answering "who's doing what?" They're not designed to answer "what did we decide and why?" or "what does an agent need to know before touching this part of the system?" Decisions live in ticket comments. Knowledge lives in a separate wiki. There's no enforced link between them.

memex.ai doesn't necessarily replace your project tracker. It's the layer underneath it — the decision and knowledge substrate that gives every ticket its context.

### "We already have Confluence / Notion / a wiki"

Wikis are where knowledge goes to die. They're write-once, read-never, maintained-by-nobody. They have no concept of staleness, no drift detection, no link to the decisions that produced them, and no awareness of whether the code still matches what they describe.

memex.ai blueprints are not pages. They're living documents with provenance, scope, and automated freshness guarantees.

### "We already have CLAUDE.md / cursor rules / .github/copilot"

These are the closest precursors to what memex.ai provides — and they validate the need. But they're per-repo, per-tool, and manually maintained. They don't connect to decisions. They don't track dependencies. They don't detect drift. They're a prototype of the blueprints layer without the decision layer or the coordination layer.

memex.ai is the managed, multi-agent, cross-repository evolution of these files.

### "We'll just put everything in the repo"

Many teams try this. Spec/spec docs in `/docs`, ADRs in `/decisions`, conventions in `CONTRIBUTING.md`. It works for small teams with one repo. It breaks when:
- You have multiple repositories that share architectural decisions
- Multiple agents need to coordinate across repos
- Documents drift from reality and nobody notices
- A decision in one repo affects work in another

---

## What Changes

### Before memex.ai

- Decisions are scattered across Slack, tickets, meeting notes, and memory
- An AI agent picks up a ticket, reads a stale wiki page, and builds the wrong thing
- Two agents work on related features without knowing about each other's constraints
- A new team member spends two weeks absorbing tribal knowledge
- Re-prioritisation is chaotic because nobody can trace the decision graph
- Documentation is always wrong, and everyone knows it, and nobody fixes it

### After memex.ai

- Every initiative has a Spec that articulates the objective — the context that makes every decision and work item intelligible
- Every decision has an ID, a status, a rationale, and explicit links to the work it affects — all traceable back to the Spec that spawned it
- An AI agent reads the Spec, the decision graph, and relevant blueprints before writing code — and stops if something is unresolved
- Agents coordinate through a shared context layer, not through hope
- A new team member (human or AI) loads the Spec and relevant blueprints and starts contributing immediately
- Re-prioritisation is a graph operation: reverse Decision D4, see the cascade across the Spec, make an informed choice
- Institutional knowledge stays current because the system detects when it drifts

---

## Getting Started

### Step 1: Connect your first agent

memex.ai runs as an MCP server. Point your AI coding agent at it. The agent immediately gains access to your decision graph, work items, and blueprints.

### Step 2: Capture your first Spec

Start with one initiative. Define the Spec (the why and the what-success-looks-like), log the open decisions, scope the work items, and write the blueprints that agents will need. This takes less time than writing the equivalent Jira epics — and it's immediately useful.

### Step 3: Watch the cycle work

An agent picks up a work item, loads the relevant blueprints, checks for blocking decisions, and produces an execution plan. You review the plan, the agent implements it, and the system prompts you to update any affected blueprints. Drift detection starts running from day one.

### Step 4: Scale

Add more Specs. More agents. More team members. The graph grows, but it stays coherent because every node is linked, every decision is traceable, and every blueprint is monitored.

---

## The Core Bet

The history of software tooling follows the bottleneck.

When the bottleneck was **compilation**, we built better compilers. When it was **integration**, we built CI/CD. When it was **communication**, we built agile and Scrum. When it was **deployment**, we built Kubernetes and infrastructure-as-code.

The bottleneck has shifted again. AI agents have made implementation fast and cheap. The new bottleneck is **planned software work** — articulating what we're trying to achieve, resolving the ambiguity that blocks progress, and ensuring every agent and every human in the system acts on the current set of decisions with the current institutional knowledge.

**memex.ai is the tool for this new bottleneck.**

Not another project tracker. Not another wiki. Not another AI coding assistant. The Spec, decision, and knowledge layer that makes all of them coherent.

---

*memex.ai — Because the hardest part of building software was never writing the code.*

---

**Learn more at memex.ai**
