/**
 * Variant B starter spec — golden seed fixture (spec-426 dec-3 / s-6).
 * ---------------------------------------------------------------------------
 * The treatment arm of the provisioning A/B (spec-426): instead of spec-178's
 * five frozen `is_demo` walkthrough copies (Variant A), Variant B seeds ONE real,
 * editable Spec — "Understanding Memex" — into a new personal Memex.
 *
 * Unlike the handhold demo:
 *   - it is `is_demo = FALSE` — a genuine, searchable, agent-visible, fully
 *     editable Spec (the user's first real artefact), not a badged tutorial copy;
 *   - it is seeded at status `done`, carrying a FULL lifecycle demonstration —
 *     genuine resolved decisions (with rejected alternatives), completed tasks,
 *     and illustrative ACs rendered verified via synthetic passing test-events.
 *
 * HARD CORRECTNESS INVARIANT (spec-426 dec-3 / ac-2 / ac-3 / s-6):
 *   The Spec AND every child (decisions, tasks, ACs, synthetic emissions) are
 *   SYSTEM-attributed — never the new user. Verified against journey-state.ts:108–191,
 *   where every onboarding milestone counts ONLY rows whose `createdByUserId` /
 *   `actorUserId` equals the user (hasSpec L108–117, hasResolvedDecision L120–123,
 *   hasAc L126–129, acVerified L151–164, planGrounded's task L171–175 + AC-test
 *   L178–191). A system-attributed starter spec therefore cannot advance the user's
 *   own onboarding journey, even though it is `is_demo=false` and carries tasks +
 *   verified ACs. seedStarterSpec() enforces this by writing every row through a
 *   ctx that carries NO actorUserId (NULL attribution = the documented "system write"
 *   of actor.ts), and by never threading a createdByUserId. The seed is the new
 *   user's first spec, teaching what a spec IS by being one — but it remains the
 *   SYSTEM's spec until the user authors their own.
 *
 * Content is the spec-426 s-6 "Understanding Memex" white-paper-adapted prose
 * (dec-3 voice fork — adapted into native spec form, NOT pasted verbatim), lifted
 * into this fixture. seedStarterSpec(memexId, ctx) maps it through the existing
 * service primitives (createDocDraft / addSection / createDecision / resolveDecision /
 * createTask / updateTaskStatus / createAc) exactly as handhold-demo.ts does, then
 * flips documents.status to `done`.
 */

export const STARTER_SPEC_TITLE = "Understanding Memex";

// ---------------------------------------------------------------------------
// Narrative sections (spec-426 s-6). `overview` is the Spec's purpose/Overview,
// seeded by createDocDraft; the rest are appended via addSection.
// ---------------------------------------------------------------------------

export const STARTER_SPEC_SECTIONS = {
  overview: `This is your first spec — and it is about the system you are now holding.

For most of software's history a specification was a *document*: written, half-read, abandoned the moment the first line of code landed. That was tolerable because the engineer had sat in the planning meeting and could fill the gaps from memory — the document never had to carry the whole truth, because a human did.

On an AI-native team that arrangement breaks. The thing writing the code is increasingly an agent that was not in the meeting and has only the artefact you hand it. Give it prose and it fills your gaps with confident invention — fluent code that does precisely the wrong thing, fast.

The fix is not a tidier document; it is a different *shape* — a specification an agent can query, write back to, and be held to. That shape is a database. Memex is the system that makes the specification one.

This spec is itself an example: read it, edit it, or delete it and write your own.`,

  comparison: `A ticket and a document are both *passive*: they sit there, and an agent cannot safely act on either without a human filling the gaps from memory. Memex makes the specification *active*.

| | Jira / ticket tracker | Markdown / Word spec | Memex |
|---|---|---|---|
| A unit of work is | a flat ticket | a section of prose | six linked records |
| Decisions live | in comments nobody rereads | buried in the prose | first-class records |
| "Done" means | a status someone drags | nothing; prose can't self-report | derived from the tests |
| An agent can | read text, no scoped context | load the whole file | query the exact slice |
| When reality moves on | the ticket silently rots | the document silently rots | drift detection flags it |
| Memory across work | none; each ticket an island | none; starts from scratch | a knowledge graph |`,

  principles: `1. **AI is the operating system, not a tool.** The work should run *through* the intelligent layer, which means every decision, check, and unit of work lives somewhere an agent can read and act on.
2. **Every important process is a closed loop.** Building software should watch its own output and correct, so "done" is something the system *observes*, not something a person *asserts*.
3. **The work must be machine-readable.** Every important action leaves a structured artefact the system can learn from. The test: give the models as much context as you would give a new employee.
4. **Engineering runs as a software factory.** The human writes the spec and the tests that define success; the agents generate the implementation and iterate until the tests pass. (The boldest and least-settled principle — held as direction, not dogma.)`,

  oneIdea: `If you take one thing from this spec, take this: **your work is no longer a pile of documents that humans keep current. It is a living, machine-readable knowledge graph that an AI operates on directly.**

Every decision, every unit of work, every definition of done is a typed record an agent can read, write back to, and be held to — not prose it has to interpret, and not a status someone remembers to drag. The graph is the source of truth, and it stays true because the system reconciles it, not because a person finds the time to.

Everything else in Memex — specs, decisions, acceptance criteria, standards, drift detection — is a consequence of that one move: turning the specification from a document a human maintains into a substrate an agent acts on.`,

  whatSetsApart: `You have seen the comparison table. Here is what it adds up to — the handful of things a ticket tracker and a Markdown spec structurally cannot do, and Memex does:

- **Done is observed, not asserted.** Acceptance criteria are real records, and a test run reports against them automatically. "Complete" is a fact the system watches arrive — a closed loop — not a box someone ticks.
- **Decisions are first-class memory.** Every "we chose X over Y, because Z" is its own record, with the rejected options kept beside it. The reasoning survives the work instead of dying in a comment thread, so no one relitigates a settled call.
- **The spec is what the agent acts on.** An agent doesn't read a file and guess; it queries the exact slice it needs and writes its results back to the same graph. The artefact and the workspace are one thing.
- **Standards are durable, locked decisions.** A choice that should bind *all* future work graduates from a one-off decision into a standard — a rule the agent consults before it writes, and flags when the code drifts away from it.
- **Drift is caught, not discovered.** When reality moves on, the system surfaces the gap between what the spec says and what the code does — instead of letting the spec quietly rot into fiction.`,

  gettingStarted: `Reading this spec is the lesson. Writing your own is the point — and doing it for real is what actually finishes your onboarding. Here is the shortest path from here to a real spec of your own.

1. **Connect your coding agent over MCP.** Memex is built to be driven by an AI agent as much as by you. Point your coding agent at the Memex MCP endpoint so it can search, read, and write the same graph you see in this UI. (You don't have to — everything here works by hand — but the agent is where Memex earns its keep.)
2. **Create a spec.** Give it a title that names the *outcome* you want, not the task. A new spec starts in \`draft\`.
3. **Frame the overview.** In a few plain sentences, say what you're trying to achieve and why. This is the context you'd give a new teammate — and the context the agent will lean on for everything that follows.
4. **Surface a decision.** Almost any real work hides a choice. Name one — "should we do X or Y?" — and capture it as a decision, with the options and their trade-offs. This is the move that carries a spec from \`draft\` into \`specify\`.
5. **Resolve it.** Pick an option and record *why*, including what you rejected. That reasoning is now permanent memory.
6. **Pin scope with acceptance criteria.** Write down what "done" will mean as one or more acceptance criteria — the observable things that must be true. You are defining success before a line of code is written.
7. **Move to build.** With decisions resolved and ACs promised, the spec enters \`build\`: now it grows tasks, and you (or your agent) implement them, ticking each AC green as its check passes — on the way to \`verify\` and \`done\`.

That's the whole loop — \`draft → specify → build → verify → done\`. You just watched this spec demonstrate it. Now run it on something you actually care about.`,

  faq: `**Is this just Jira with extra steps?**
No. A ticket is a passive label a human drags between columns, and nothing ever checks whether it's true. A spec is an active, queryable record an agent acts on, where "done" is observed from real checks rather than asserted. The comparison table above is the short version.

**Do I have to use the AI agent?**
No. Every part of Memex works from the UI by hand. But Memex is designed so an agent can operate the same graph you do — and that's where most of the leverage is. Use as much or as little of the agent as you like.

**What happens when my plan changes?**
You change the spec — that's the point of it being *living*. Reopen a decision, add or revise acceptance criteria, adjust the tasks. And when the code and the spec fall out of step, Memex surfaces the drift instead of letting the spec quietly go stale.

**Where do standards come from?**
A standard is a decision you've chosen to make binding on all future work. When a one-off choice turns out to be a rule you want every spec to follow, it graduates into a standard — one the agent consults before it writes, and flags when the code strays from it.

**Can I edit or delete this starter spec?**
Yes. This is a real, fully editable spec — not a locked tutorial. Rewrite it, strip it for parts, or delete it entirely. Nothing here is precious; it exists only to show you the shape.

**Why is this spec already marked \`done\`?**
So you can see a complete lifecycle end to end — resolved decisions, finished tasks, verified acceptance criteria — without having to build it yourself first. Your own first spec will start at \`draft\` and earn its way to \`done\`.`,
} as const;

// The order sections are appended (overview is the doc purpose, seeded first by
// createDocDraft). Each entry maps to a unique sectionType slug + human title for
// addSection — kept here (not buried in the seeder) because section ORDER is content.
export const STARTER_SPEC_SECTION_ORDER: {
  key: keyof typeof STARTER_SPEC_SECTIONS;
  sectionType: string;
  title: string;
}[] = [
  { key: "overview", sectionType: "overview", title: "Overview" },
  {
    key: "comparison",
    sectionType: "comparison",
    title: "Memex vs a ticket tracker and a Markdown spec",
  },
  {
    key: "principles",
    sectionType: "principles",
    title: "What we believe: the four principles",
  },
  {
    key: "oneIdea",
    sectionType: "one-idea",
    title: "The one idea everything rests on",
  },
  {
    key: "whatSetsApart",
    sectionType: "what-sets-apart",
    title: "What sets Memex apart",
  },
  {
    key: "gettingStarted",
    sectionType: "getting-started",
    title: "Getting started: your first spec",
  },
  { key: "faq", sectionType: "faq", title: "FAQ" },
];

// ---------------------------------------------------------------------------
// Decisions (spec-426 s-6 — "Demonstration primitives"). Two genuine resolved
// decisions, each carrying its rejected alternative so a new user sees what a
// first-class decision record looks like. Seeded RESOLVED (createDecision →
// resolveDecision); the `chosen` text becomes the resolution and keeps the
// "Rejected: …" tail inline (mirrors handhold-demo.fixture.ts).
// ---------------------------------------------------------------------------

export const STARTER_SPEC_DECISIONS = [
  {
    title: "Should a specification be a document, or a database?",
    context: `For decades a spec was a written document — prose a human read once and then carried in their head. On an AI-native team the agent writing the code was never in the meeting; it has only the artefact. The question is whether the fix is a better-written document or a different shape entirely.`,
    chosen: `Chosen: a database. The specification becomes a set of typed, linked records an agent can query, write back to, and be held to — not prose it has to interpret. The problem was never the quality of the writing; it was the *shape* of the artefact. A document, however well written, can't be queried for the exact slice an agent needs, can't self-report whether it's done, and silently rots when reality moves on. A database-shaped spec fixes all three by construction. Rejected: *write a better document* — the instinct that feels right and fails anyway, because more polish on prose doesn't make prose machine-actionable; it's still a thing a human has to read and fill the gaps from memory.`,
  },
  {
    title: "Is AI a tool beside the work, or the operating system the work runs on?",
    context: `Most teams bolt AI onto an unchanged process — an assistant that drafts a ticket or summarises a thread while the work itself still lives in the old tools. The alternative is to make the intelligent layer the thing the work runs *through*, so every decision, check, and unit of work lives somewhere an agent can act on directly.`,
    chosen: `Chosen: the operating system. The work runs *through* the intelligent layer — every decision, acceptance criterion, and unit of work lives in a graph an agent reads and writes directly, and "done" is something the system observes rather than something a person asserts. Treating AI as the substrate (not an add-on) is what lets the loop close: the agent acts on the same records the human does, and the system reconciles them. Rejected: AI-as-assistant — a helper bolted onto the side while the real work stays on the old rails (tickets, prose, status someone drags). It captures none of the leverage, because the agent never operates the source of truth; it just decorates it.`,
  },
] as const;

// ---------------------------------------------------------------------------
// Scope acceptance criteria (spec-426 s-6 — "Demonstration primitives"). The
// starter spec sits at status `specify`, so it carries SCOPE ACs — manager-authored,
// outcome-shaped statements of what "done" would mean — and NOT implementation ACs
// or completed tasks (those are build/verify-phase artefacts that would be
// phase-incoherent in the Specify column, spec-426 dec-3 revision). They double as a
// worked example of what good scope ACs look like for a new user shaping their own
// first spec. Seeded system-attributed (actor_user_id NULL), so they never count
// toward the user's hasAc / acVerified / planGrounded (journey-state.ts:126–191).
// No synthetic test-events: an unverified scope AC is exactly right at `specify`.
// ---------------------------------------------------------------------------

export const STARTER_SPEC_ACS: readonly {
  statement: string;
  kind: "scope";
}[] = [
  {
    statement:
      "A reader can explain, in their own words, why Memex shapes a specification as a queryable database an agent acts on, rather than a written document a human carries in their head.",
    kind: "scope",
  },
  {
    statement:
      "A reader can point to where decisions, acceptance criteria, and standards live on a Spec, and explain how “done” is observed by the system rather than asserted by a person.",
    kind: "scope",
  },
  {
    statement:
      "A reader can name the five lifecycle phases (draft → specify → build → verify → done) and knows the next concrete step is to author their own first real Spec.",
    kind: "scope",
  },
] as const;
