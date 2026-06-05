# Skill: Spec Document

Reference this skill whenever you are creating, shaping, or evaluating a **Spec document** in Memex. It defines what a Spec is, what it is *not*, and how to judge scope.

## What a Spec is

A Spec is the human-readable **specification for a software initiative** — always software, always aimed at producing something inside a new or existing product. It is the artefact a team can read, argue over, and align around before any code is written.

In the Memex model, a Spec is the starting point of a pipeline:

> **Spec** → review & discussion → **Decisions** (open questions resolved by the team) → **Tasks** (tasks handed to AI coding agents for implementation).

A useful mnemonic:

> **Spec = the why.** **Decisions = the how.** **Tasks = the what.**

The Spec explains *why* this initiative matters and what shape it should take. Team discussion surfaces open questions, which get captured as Decisions — those lock in *how* the team chose to approach each question. Tasks are then derived from the settled Spec and decisions — they are the concrete *what* the code needs to become.

So a Spec is deliberately discussable: it surfaces the choices and considerations that need human input, and leaves room for decisions to be captured and tasks to be derived later. It is not a requirements doc, not a runbook, not a dump of notes — it is a coherent argument for how one software initiative will be approached.

## Required shape

Every Spec has these parts. Only the **Overview** is created up-front during the creation flow — the rest are added on request once the user has confirmed which sections they want.

1. **Overview** — first section, always. Plain-language introduction. In 2–5 sentences: what this Spec is about, why it matters now, and what the reader should take away. No jargon dump. Someone unfamiliar with the project should be able to read the overview and understand the shape of the work.

2. **Body sections** — discrete sections, one concern each. They must be independently resolvable: it should be possible to comment on, argue about, or rewrite one body section without touching the others. Give each a short, specific title.

   **Important: do not auto-add body sections during creation.** Create the Overview, then ASK the user which sections they want. Suggest the spine below as defaults — but the user picks; we don't scaffold without consent.

   **Default spine — suggest these three when asking the user, and include them when they add real value:**
   - **Design** — UX and visual design. Flows, surfaces, states, visual language.
   - **Architecture** — how this fits into the existing system. Boundaries, data model, services, contracts, notable trade-offs.
   - **Testing** — the test plan across unit, integration, and end-to-end tiers.

   Beyond the spine, add any further sections the initiative needs *if the user asks for them* (e.g. "Scope", "Data model", "Rollout", "Risks", "Open questions", "Migration"). Aim for a total that's right-sized for the work: 2–3 body sections for a tight, focused initiative; 4–7 for a larger one.

3. **Acceptance criteria** — typically the final section, when the user includes it. A concrete definition of done: what is true when this Spec is complete. Usually a markdown checklist of verifiable outcomes. Someone reading this list should be able to check each item and conclude, without judgement, whether the Spec is done. Keep the criteria within what *this* Spec delivers — don't reach into outcomes that belong to a different feature or concept's Spec.

## What a Spec is NOT

- **Not a bundle of unrelated features or concepts.** A Spec is bounded by *function*, not by time. Mixing two distinct features or concepts ("multi-tenancy AND billing redesign AND a new notifications system") is what gets split — not the fact that design, build, and launch all happen inside one Spec.
- **Not a whole product.** If the input covers everything an app does (many features across many surfaces), it's usually many Specs. Split along feature / concept lines until each Spec is about ONE thing a team could deliver end-to-end.
- **Not a todo list.** Tasks live on tasks. A Spec explains the approach; tasks come later.

**Phases are fine inside one Spec.** Design, architecture, build, testing, rollout, and launch for a single feature can and often should live in one Spec, because together they're what makes that feature actually deliverable. Splitting those across multiple Specs is usually a mistake — it prevents any one Spec from delivering end-to-end value on its own.

Note: "not a Spec" never means "refuse to create it". It means *shape it into one* (or more) before creating.

## Is the work big enough to warrant a Spec?

Some software work is too small to need a Spec. Signs:

- The change is one line or a few lines: a typo, a config tweak, a single-line bug fix.
- There are no real choices to make — only one obvious way to do it.
- No standards or decisions need to be consulted or established.
- One person can complete it in minutes, with no team coordination.

For this kind of work, **propose a lighter path** before defaulting to a new Spec. Offer the user a choice via `render_choices`:

- **"Add as a task on an existing Spec."** If a related Spec is in `build`, the small fix can live there as a task — same tracking, no new container. Use `list_docs({ docType: 'spec' })` first to find candidates.
- **"Handle as a one-off."** If the work doesn't fit anywhere obvious and doesn't warrant tracking, just do it. Memex is the system of record for *substantive* work; one-off fixes don't need to live in it. The cost of a Spec for a typo is more friction than benefit.
- **"Make it a Spec anyway."** Sometimes the user wants the work on the record even if it's small. That's a valid override — proceed with creation.

If you proceed with creation for a single-item Spec, drop the same `render_callout` (tone "tip") used for single bugs, noting that Specs pay off more over a batch of related items.

## Scope test — use this before every `create_doc`

The test is about *functional coherence*, not about phases. Phases (design → build → launch) live happily inside one Spec — that's what makes a Spec deliverable. The question is whether the Spec is about one thing.

Ask yourself:

1. **Can I write the Overview in one focused paragraph without the word "and" joining distinct features or concepts?**
   If the Overview sounds like "we'll do X and also do Y and also do Z," those are probably separate Specs.

2. **If a team shipped only this Spec — nothing else — would they have delivered something of real value to users?**
   A Spec should be deliverable on its own. If shipping just this leaves a user-facing gap that requires another Spec to make sense, the scope may be wrong (too narrow), or the acceptance criteria may be reaching into territory that belongs to another Spec (too broad).

3. **Could a reasonable team split the work across two leads with each owning a self-contained feature?**
   If yes, it's probably two Specs.

4. **Does the acceptance criteria mix outcomes from distinct, independent concepts?**
   E.g. a checkbox about a multi-tenancy migration sitting next to a checkbox about a billing redesign — those are different concepts, and they belong in different Specs.

## Worked examples

**Good — one focused Spec, multiple phases inside:**
- *"Add multi-tenancy to the application."*
  One cohesive feature. The Spec spans Design (tenant-switcher UX), Architecture (data model, row-level scoping, middleware), Build, Testing, and even a Rollout / migration plan — all in one document. Acceptance: every resource query is tenant-scoped; an E2E test with two tenants passes; the migration is reversible. Shipping this Spec alone delivers real user-facing value.

**Bad — multiple distinct features bundled as one:**
- *"Add multi-tenancy, redesign billing, and migrate payments to a new provider."*
  Three independent features. Each has its own users, its own definition of done, and could ship without the others. Split into three Specs, one per feature — even though each of those Specs individually will still span design → build → launch.

**Bad — a whole product as one Spec:**
- *"Build the dog-walking app."*
  Too broad. This is many features (booking, scheduling, payments, notifications, user profiles, discovery…). Ask the user which feature to start with, or propose creating several Specs — one per discrete feature. Each feature Spec covers design through launch for that feature alone.

**Converting a dump into a Spec — this is your job, not a refusal case:**
- *Input: a pasted backlog of 20 things the checkout flow needs.*
  Don't ask the user to rewrite it, and don't refuse. Read the list, find the through-line (e.g. "simplify the address step to reduce drop-off"), pick a title that captures it, and use the items as raw material for the body sections. A "Scope" or "Items in this Spec" body section can carry the original list, reorganised. Architecture, Design, Testing still get their own sections. Acceptance criteria covers only what this Spec delivers, not the entire backlog.

- *Input: a single bug report.*
  One bug is still a valid Spec if the user asks for one. Frame it as a Spec scoped to fix the bug: the Overview explains the user-visible problem and the intent to fix it; body sections cover only what's needed (often just Architecture for the root cause + Testing for a regression test, sometimes Design if the UX changes). Acceptance: the reproduction no longer triggers, a regression test covers it, no regressions elsewhere.

  Before creating a single-item Spec, drop a short `render_callout` (tone "tip") noting that Specs pay off more over a batch of related items, and that pasting several related bugs or a chunk of feedback lets Memex group them, surface shared decisions, and produce the right tasks in one pass. Then proceed.

- *Input: "a few things the team wants to do this quarter".*
  This is almost always multiple Specs. Name each distinct initiative in one sentence, then ask the user (via `render_confirmation`) whether to create Specs for all of them. If confirmed, create each one — same rigour on each.

## How to use this skill when creating

- **Search the Memex before creating.** Call `search_memex({ query })` with the key phrases from the user's input *before* proposing a title or Overview. Omit `kind` to search Specs, Standards, free-form docs, and Decisions in one call. Two patterns to watch for:
  - **A Spec already covers this** — surface the match in the confirmation message and ask whether to extend it instead of creating a new one.
  - **A relevant Standard or prior Decision exists** — mention it briefly so it becomes part of the new Spec's context (load-bearing constraints don't get rediscovered later).
  Skip this step only for obviously trivial input (a single-line typo, a one-off ask).
- **Always produce a Spec from whatever you get.** A paragraph, a list of bugs, a pasted spec, a single issue — all are valid. Never refuse; convert.
- **Ask at most one or two clarifying questions**, only if something genuinely critical is missing. Otherwise make reasonable assumptions and move into creation.
- **Identify the *one thing* it is about.** If you find multiple distinct features/concepts, name each in one sentence, then use `render_confirmation` to ask whether to create one Spec for each.
- **Write the Overview first**, in the user's vocabulary. If you cannot write it as one focused paragraph, the scope is wrong — split.
- **Confirm only the title and Overview before calling create_doc** — `render_confirmation` should propose the title and a one-line overview. Don't list body-section titles in the confirmation; that decision happens after the Overview lands.
- **After create_doc returns, ASK the user which sections they want.** Use phrasing like "Would you like me to add Scope, Design, Architecture, Testing, and Acceptance criteria sections, or specific ones?". Wait for an answer before any add_section call.
- **Add only the sections the user asks for.** Reuse their terms. Short, specific titles. Don't pad with stubs; don't add the spine without consent.
- **Write acceptance criteria** that are verifiable and stay within what this Spec delivers — only when the user asks for that section.

## Background — surface only when a user asks

**Agile / Kanban mapping.** Roughly: Spec ≈ Epic; Task ≈ Story (or a small cluster). Decisions have no direct Agile analogue — they capture resolved design / trade-off choices. Memex deliberately uses different terms because the workflow is designed for teams working with multiple AI coding agents, where separating *why* (Spec) from *how* (decisions) from *what* (tasks) matters more than when humans hold all the context in their heads.

**The three working document types.**
- **Spec** — the substrate for planned software work, captured here. The pipeline: Spec (the *why*) → Decisions (the *how*) → Tasks (the *what*). Specs are deliberately discussable and forward-looking.
- **Standard** — a living rule document the agent maintains. Sections contain rules, conventions, or invariants, with `[per spec-N:dec-M]` provenance links citing the decisions that justify each rule. The agent flags drift (typed `drift` comments) when those decisions resolve.
- **Document** — a generic knowledge artifact: specs, ADRs, runbooks, design notes, architecture overviews. No special agent maintenance; first-class container for human-authored content.

**Specs vs Standards.** A Spec can legitimately conflict with the current codebase: Specs are forward-looking (the *why* and the shape of change). Standards live alongside the code and keep it honest once decisions are settled and tasks are in flight.

**Citing decisions inside standards.** When you author or update a standard (docType='standard') and need to cite a decision, always write the **qualified** reference: `[per spec-N:dec-M]` — the parent Spec's handle, a colon, then the decision's handle. Decision sequences (`dec-N`) are per-Spec, not per-account, so the same `dec-7` can exist in two Specs. The qualified form is unambiguous; the bare `[per dec-N]` form is still parsed for legacy content but UI deep-links and the `getDecisionByHandle` lookup return a 409 with a candidate list when a bare handle collides. The older `[per doc-N:dec-M]` form also continues to parse as legacy. Use `[per spec-N:dec-M]` for every new reference.
