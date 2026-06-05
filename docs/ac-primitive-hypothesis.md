# Acceptance criteria as a Memex primitive: the hypothesis

*An opinion piece. Companion to whitepaper v3. Captures the argument for adding `ac` as a first-class primitive inside a Brief, alongside `decision`, `task`, and `comment`.*

## The argument in one paragraph

Memex captures *what was chosen and why* through Decisions, beautifully. It says nothing about how the system, once built, demonstrates that the choice was and is being honoured.

The bridge from "we decided this" to "the code reflects that decision" is implicit, lives in prose, and decays the moment someone changes the code without revisiting the Brief. We propose adding **acceptance criteria** (AC) as a forward-facing primitive: testable assertions about what the system must do, addressable by stable IDs, linked to tests in the codebase that emit pass/fail signals back to the workspace. ACs come in two flavours: **Scope ACs** authored by managers as plain-English outcome commitments (the product audience), and **Implementation ACs** spawned by agents from resolved Decisions and auto-accepted (the engineering audience).

With both, the workspace knows continuously whether the deployed system still does what the team decided it would, and the manager can pattern-match on aggregate signals rather than reading every assertion.

## A note on the word "manager"

Throughout this document we use **manager** for the human-in-the-loop role. The reason: the role formerly known as "human developer" is increasingly a managerial role. The work is no longer line-coding; it's directing an army of AI coders, pattern-matching on their output for signs of trouble, and steering. The core human skill is a nose for when the agents are off-track, exercised on thin slices of information. That's a manager's job, not a developer's. Calling this role what it actually is helps the reader frame the change in working practice that this hypothesis assumes.

"Human" is reserved for moments where we're contrasting authorship origin (human vs agent). Where we're describing the role, we use manager.

## The PRD analogy

The simplest way to orient: ACs formalise something every software team already does, just under a different name.

| Today's world                          | Memex                                                           |
| -------------------------------------- | --------------------------------------------------------------- |
| PRD written by product                 | Brief + Scope ACs (travel together as the product view)         |
| Acceptance criteria in PRD             | Scope ACs (plain English, business-readable, sign-off material) |
| Engineering planning session           | Decision resolution phase                                       |
| PRD → stories                         | Brief → Implementation ACs (one per testable assertion)        |
| Story-level ACs                        | Implementation ACs (technical, the engineering audience)        |
| Product person not reviewing story ACs | Manager not gating Implementation ACs                           |

We're not inventing a new abstraction. We're formalising the product/engineering split that many a team already operates inside, and making both halves machine-addressable so the workspace can hold the team to them.

## The pain ACs address

Today Memex captures the *front* of the work loop and goes quiet at the *back* of it. The verify phase exists in the lifecycle, but `assess_brief` reports on workspace state (open decisions, incomplete tasks), not on code state. A Brief can pass verify with every decision resolved and every task complete, and the code shipped can still diverge silently from what the Brief said.

This is the failure mode every team has hit forever: documentation drifts from code, the team stops trusting the documentation, decisions get re-litigated in Slack threads, the rationale captured in `dec-12` is six months out of date and nobody noticed. Memex was supposed to be different because Decisions are first-class objects, not prose paragraphs. But first-class objects without an empirical link to code are still just structured prose. **They decay the same way; they just decay more legibly.**

## What ACs add and what they don't replace

**Decisions stay.** They remain the primitive for forks: contested choices the team had to settle, with rationale and rejected alternatives. The act of framing a fork is itself a discovery tool. In one recent spec-68 transcript, three of the best design moves (dropping an enum, dropping a disclaimer, treating transition gates as scaffold content) only surfaced because a Decision was framed. An AC-first flow would have accepted the bad mechanism as readily as the good one, because ACs are silent on which choice was made and why.

**ACs add what Decisions cannot.** A resolved Decision tells you "we chose Redis with TTL invalidation." An AC tells you "the system uses Redis with TTL, default 5 minutes" in a form a test can assert.

> Decisions hold the WHY (and the alternatives, and the rationale). ACs hold the WHAT (the assertions the running system must satisfy). Both are needed. Neither subsumes the other.

**The AC primitive is testable, addressable, and trackable.** It carries a handle (`ac-N`), a forward-facing statement, a state, and zero or more tests in the codebase that emit `(ac_uid, status)` events to a centralised store. The workspace materialises a view: of every active AC, which ones have passing tests, which are failing, which have no tests at all. The verify phase becomes a query, not a vibe.

## Two flavours: Scope and Implementation

The two flavours serve two different audiences and enter the workflow at different points. They share a data shape but their lifecycles differ.

|                    | Scope AC                                                                           | Implementation AC                                                                |
| ------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Audience           | Product, manager, business                                                         | AI coders, the workspace as monitor                                              |
| Authored by        | Human, with the Brief                                                              | Agent, from resolved Decision                                                    |
| When               | Draft / early plan                                                                 | Late plan, after Decision resolves                                               |
| Language           | Plain English, outcome-shaped                                                      | Technical, mechanism-shaped                                                      |
| Direct parent      | The Brief itself                                                                   | One or more Decisions (sometimes none: defaults, mid-build discoveries, imports) |
| Acceptance posture | Human-authored = human-accepted                                                    | Auto-accepted; agent flags exceptions for the manager's attention                |
| Where it appears   | Travels with the Brief body, rendered at the bottom (like the AC section of a PRD) | Separate surface; visible on demand, not in the headline view                    |

Both can have zero or many tests. A broad Scope AC like *"admins can extend the agent's prompting without changing the base"* might pair with fifteen tests, each asserting a granular aspect. A narrow Implementation AC like *"the cache TTL defaults to 5 minutes"* might pair with one. The AC primitive is uniform; what varies is breadth-of-statement-to-test-density.

## Where ACs sit in the workflow

Six steps. Scope ACs appear early, Implementation ACs appear after Decisions resolve, tests come during build, drift detection runs forever after.

1. **Brief created.** Purpose and narrative drafted by the manager with agent assistance.
2. **Scope ACs authored.** Manager commits to outcomes. These set the boundary for what success looks like and drive the agent's proposed Decision corpus.
3. **Decisions framed and resolved (`plan` phase).** Agent proposes Decisions, tagging each as either a **fork** (real contention; resolve interactively) or a **corollary** (downstream of an earlier choice; batch as one "consequential defaults, confirm?"). The manager can promote any corollary to a fork by disagreeing; the cost of the agent's wrong tag is one extra turn.
4. **Implementation ACs spawned.** As each Decision resolves, the agent decomposes it into Implementation ACs and they auto-accept. The agent flags individual ACs for the manager's attention only when it has a specific concern (interpretation ambiguity, conflict with another AC, scope it couldn't determine).
5. **Build.** AI coders write code and tests for each Implementation AC. Tests emit pass/fail events tagged with the AC UID. ACs flip to verified as their tests pass.
6. **Verify and signoff.** Workspace reports AC coverage (% of ACs with at least one passing test). The manager signs off when AC coverage meets the team's threshold AND, in their judgment, the implementation satisfies the Scope ACs committed to at step 2. Tests keep running forever after; drift surfaces as soon as the code disagrees with an AC.

Scope ACs can evolve during step 3 if Decision resolution exposes a missed commitment. The flow is a spine, not a forced linear march.

## The labour model: agents do the work, managers signal-detect

The AC primitive does NOT add a new manager gate. The manager's three touchpoints stay at the natural altitudes the rest of Memex already operates at.

| Moment                                                   | Altitude    | What the manager does                                                |
| -------------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| Brief authoring, Scope AC authoring, Decision resolution | Strategic   | Approves intent, makes contested choices, commits to outcomes        |
| Drift response                                           | Operational | Evaluates the agent's situation report; decides which fix to approve |
| Brief signoff (verify → done)                           | Strategic   | Confirms the implementation satisfies the original Scope ACs         |

Nothing between Decision and code. Implementation ACs auto-accept; the agent does the decomposition; the workspace records the result.

The reason for auto-acceptance is the manager reality. The manager today doesn't read line-by-line; they pattern-match on signals (coverage trends, drift events, flagged exceptions, oddly-shaped output) the way a manager pattern-matches on a team. Their core skill is a nose for when something is off. Asking them to read 47 Implementation ACs at creation time defeats this posture; the workspace's job is to surface only what merits their attention. If everything's green, they should see "everything's green" and move on.

## The three responses to a red AC

When a test for an AC goes red, the agent investigates, classifies the cause, and approaches the manager with a **situation report**: what changed, what the agent thinks happened, a recommended fix, and links if the manager wants to go deeper. The manager evaluates the recommendation, drills in if they choose, and either approves the fix or redirects.

Memex's job isn't to red-light something on a dashboard and walk away. It's to present the situation, the analysis, and the recommendation, and let the manager act at the altitude they choose.

Three cases the agent's investigation lands on:

1. **Code is wrong; AC and Decision are right.** A regression. Agent proposes the code fix; the manager confirms; the agent ships.
2. **AC is wrong; Decision is right.** The agent originally misread the Decision (interpretation slip, or letter-vs-spirit mismatch where the AC technically captured the Decision's words but missed its intent). Agent proposes the revised AC and the corresponding code update; the manager confirms; the agent applies both.
3. **Decision was wrong.** Right at the time, but the world changed, or a mistaken assumption surfaced, or a better option emerged. The agent surfaces this with a recommendation to reopen the Decision. The new resolution is the manager's call to make. Once re-resolved, the agent compares old vs new resolution against the linked ACs and updates them automatically (some go `superseded`, new ones spawn `active`). The manager signed off on the new resolution; the AC churn that follows is mechanical.

The drift signal doesn't classify the cause. The agent's investigation does, and the manager's judgment is in evaluating the agent's call.

## What we deliberately don't do

**No LLM judge at runtime.** LLM judgement is non-deterministic. A flaky drift signal destroys trust faster than no signal at all; the boy-who-cried-wolf failure mode is real and not mitigable. So the drift signal stays deterministic: tests pass or fail, AC status reflects the latest event, the workspace reports facts. LLMs help authoring (writing the test from the AC) and investigation (proposing the cause and fix when drift fires), but never adjudicate the signal itself.

**No claim that every decision becomes an AC.** Many Decisions are about naming, scope, or process and have no testable consequence. Those stay as Decisions in prose, never spawn Implementation ACs, and live on trust. The workspace surfaces this honestly via coverage metrics, and the team is free to invest in coverage or accept the gap.

**No outcome-level drift detection.** ACs detect *implementation-level* drift (does the code do what we said it would?). The trust-engine question (*did the world move the way we hoped?*) is a separate layer, upstream of ACs, not part of this hypothesis. ACs assume the team's outcome model is correct.

## The bet

We are betting that adding a primitive whose entire job is to be the empirically-checked claim about system behaviour will change how teams work with AI assistants:

- **Decisions get sharper**, because every resolved Decision now has a downstream act of decomposition that exposes vagueness. A Decision that can't be decomposed into Implementation ACs is a Decision that wasn't really resolved.
- **AI coders get clearer instructions**, because the AC is the contract: write the code, write the test, the test emits the signal, done.
- **The verify phase becomes a query, not a vibe**, because every AC's status is known empirically.
- **Drift becomes detectable**, because when an AC's test goes red months after a Brief is closed, the workspace knows, the agent investigates, and the manager gets a situation report rather than a silent failure.
- **Trust accumulates**, because the team can see, at a glance, how much of their decision surface is backed by passing assertions and how that fraction has grown over time.
- **The manager's attention is preserved**, because the workspace surfaces only the signals that merit a look (coverage drops, drift events, agent flags) and the agent investigates before approaching them, instead of demanding line-by-line review.

The agent does the decomposition work and the investigative work. The manager's attention is reserved for the moments that demand it, and arrives pre-loaded with the agent's analysis.

## Where this could fail

Three fragility points, each paired with the structural guards that turn them into detectable signals rather than silent failures.

**Implementation ACs that look technically right but don't actually cover what the Decision meant.** The letter-vs-spirit gap. The agent extracts assertions from a Decision; the assertions pass; the outcome still isn't what the team wanted. Partially mitigated by the drift-response loop and the manager's signoff judgment, but not eliminated. The workspace can't prevent this; it can only make it visible quickly when it surfaces.

**AI process failures in the test-writing loop.** This hypothesis assumes AI coders write the implementation AND the tests, with the AC UID emission baked into each test at authoring time. That assumption is load-bearing. If managers had to remember to write tests and tag them with UIDs, the system would just push documentation-and-code drift down a level. But AI isn't infallible. The known failure modes:

- AI writes a test but forgets the AC UID emission. Test passes silently; AC stays untested.
- AI writes a weak test that asserts something trivially true (`assert RADIUS is not None`). AC shows verified; signal is noise.
- AI mistags the AC UID (typo, stale reference after a rename). Wrong AC flips to verified.
- AI skips writing tests for some ACs because the instruction set wasn't precise. ACs sit active-untested.
- Emission infrastructure breaks silently. Tests pass, events don't land.

The structural guards, none of them depending on the manager noticing:

- **Pre-commit gate scoped to the AI session.** Each AI build session is given a specific list of Implementation ACs to deliver, and that list is written into the PR's metadata (commit trailer, manifest file, or branch convention). CI verifies that every AC in the metadata has at least one test in the PR that emits its UID, and rejects the PR otherwise. This is a *workflow expectation* on the AI session, not a *schema constraint* on the AC primitive (which still permits zero-or-more tests in general; this gate applies only to ACs the AI was told to deliver in this session).
- **Coverage staleness check.** Any Implementation AC sitting `active` for more than N days with no emission gets flagged. The agent investigates and either writes the missing test, surfaces a reason it can't, or proposes the AC be revised.
- **Emission integrity check.** Every event posting an `ac_uid` is validated against the workspace's AC set. Unknown UIDs get logged as anomalies (typos, stale references after renames).
- **Test-quality heuristic.** The agent's test-authoring step has a self-review pass that asks "does this test actually assert the AC, or is it a stub?" Not foolproof, but catches the most obvious "is_not_none"-shaped tests.

None of these is perfect. The standard isn't perfection; it's **better than the alternative**. To borrow Joe Biden's line: don't compare these mechanisms to the Almighty, compare them to the alternative. Today: devs write tests sometimes, documentation drifts from code, nobody knows until something breaks in production. With these guards: AI writes tests by default, structural checks catch the common AI mistakes, coverage staleness surfaces the gaps, emission integrity catches the typos. Residual failures will exist. But a measurable fraction of what today is invisible becomes visible. That's the bar. For now.

**The fork/corollary tagging being wrong often enough to undermine batched corollary review.** If the agent mis-tags fork-type Decisions as corollaries, the manager has to either catch them in the batch or accept worse decisions. If it mis-tags corollaries as forks, the workflow gets longer with no upside. Tuning this is empirical, not architectural.

## Next steps

The AC primitive is being prototyped on the `feat/ac-spike` branch against a local Memex instance (see [`local-mcp-client.md`](local-mcp-client.md) for setup). The spike adds the schema, the service layer, the MCP tool surface, and a real probe: translating an existing Brief's Decisions (probably `b-60`, "Pulse") into ACs and observing how the model holds in practice. The test-emission half (the `test_events` table, the signal pipe, the AC-coverage view) follows once the primitive itself is solid.

If the spike validates, the next conversation is about the migration path for existing Briefs and the rollout to int and prod. If it doesn't, we know more about the failure modes of the primitive than we do today and the team is better placed to decide what to try next.

The hypothesis is fallible. The work is to test it.

---

# Part II — How it's implemented

The hypothesis above frames why this primitive matters. The rest of this doc captures HOW the V0.0.1 implementation actually works, so a reader (human or agent) coming in cold can locate any piece of the system without re-deriving it from the codebase. Sections are organised top-down: schema → service → HTTP → emission helper → UI → real-time → operational gaps. Reference paths are stable as of the merge that landed this implementation; if you're touching the code and they've drifted, fix the path and keep the rest.

## Schema (`drizzle/0061_add_acs.sql`)

Four tables, all introduced in one migration. Tenancy lives on the AC row via `memex_id` + `brief_id`; parentage is separate (polymorphic) so blast-radius cascades from a Decision change can walk only the parent graph without touching tenancy.

- **`acs`** — the AC primitive. Columns: `id`, `memex_id`, `brief_id` (FK to `documents`), `seq` (per-brief monotonic, unique with `brief_id`), `kind` (`scope` | `implementation`), `statement`, `status` (`proposed` | `active` | `rejected` | `superseded`), timestamps. The handle is `ac-N` per Brief; `(brief_id, seq)` is the unique constraint backing the handle. `seq` is allocated via the same `withSeqRetry` machinery as decisions/tasks (see `services/shared/sequence.ts`).
- **`ac_parent_links`** — polymorphic many-to-many. `(ac_id, parent_kind, parent_id)` primary key. `parent_kind` is `brief` (typical for Scope ACs, parent is the Brief itself) or `decision` (typical for Implementation ACs spawned from a resolved Decision). No FK on `parent_id` because it's polymorphic; integrity is enforced at the service layer. Orphan rows are tolerable at V0.0.1.
- **`task_satisfies_ac`** — many-to-many between Tasks and ACs. Tells the workspace which Tasks are working toward which ACs; the verify-phase rubric uses it to show "is there code-side work in flight for the untested ACs?"
- **`test_events`** — append-only log of pass/fail emissions from tests in the codebase. Columns: `id`, `ac_uid` (text), `status` (`pass` | `fail` | `error`), `test_identifier` (text, typically `file::function`), `duration_ms`, `commit_sha`, `run_id`, `created_at`. Indexed on `(ac_uid, created_at DESC)` and `(test_identifier, created_at DESC)` for the two primary lookups.

Two intentional design calls in this schema, both load-bearing:

1. **`test_events.ac_uid` is free-text, not an FK to `acs.id`.** The emitter (a test in a codebase the workspace doesn't control) writes a canonical ref string — `<namespace>/<memex>/briefs/<brief-handle>/acs/ac-<seq>` — that the workspace resolves at query time. The cost: a typo or rename produces an orphan row instead of a 500. The benefit: rename robustness, no migration coupling between the workspace and N codebases, no FK contention on a hot append-only table. Orphans surface via the emission-integrity check listed in the failure-modes section.
2. **No `test` primitive in Memex.** The codebase owns its tests; Memex owns the assertion about what they should prove. Adding a `tests` table would create the documentation-and-code drift problem inside Memex itself (a `tests` row pointing at a deleted file). The current shape avoids it entirely.

## Service layer (`packages/server/src/services/acs.ts`)

Two halves. The CRUD/lifecycle half mirrors decisions/tasks: `createAc`, `listAcsForBrief`, `getAc`, `updateAc`, `deleteAc`, `acceptAc`, `rejectAc`, `linkAcToParent`, `unlinkAcFromParent`. All writes go through `mutate()` per the Reactivity Standard so the bus emits and the activity log records.

The verification half is the part the AC tab consumes:

- **`listAcsForBriefWithVerification(memexId, briefId)`** — denormalised snapshot per AC. Joins the AC rows to their `test_events` (via the constructed canonical ref) and derives a `verificationState`:
  - **`untested`** — zero test events ever for this ac_uid.
  - **`failing`** — any test's latest emission is `fail` or `error`. Partial pass is not enough; one red test means the AC isn't honoured.
  - **`stale`** — all tests' latest emissions are `pass`, but the most recent run is older than `STALE_THRESHOLD_DAYS` (7, hardcoded — see the constant for the comment justifying the value).
  - **`verified`** — all tests' latest emissions are `pass` and the most recent run is inside the staleness window.
- **`listAcAlignmentOverTime(memexId, briefId, days = 30)`** — daily snapshots for the sparkline. For each day in the window × each AC `kind`, computes `(verified, total)` where `total` is "ACs that existed by end-of-day" and `verified` is "ACs in scope whose latest test_event ≤ end-of-day is `pass`". Both gated on AC existence so synthetic seed data that emits before the AC's `createdAt` can't produce nonsensical `verified > total`.

Two implementation notes that matter when you read the code:

- The events lookup uses `inArray` on the constructed ref set rather than raw `ac_uid = ANY(...::text[])`. drizzle/postgres-js doesn't auto-cast TypeScript string arrays to Postgres arrays; using `inArray` keeps the parameter binding sane.
- The history query builds `ac_set` from an inline `VALUES` clause (via `sql.join`), not `unnest(...::text[])`, for the same reason. It then `CROSS JOIN`s with a `generate_series` of dates and computes `latest_status` via a correlated subquery per (day × ac).

## HTTP routes (`packages/server/src/routes/acs.ts`)

Tenant-scoped, mounted at `/api/:namespace/:memex/acs` (and flat-mounted at `/api/acs` for entity-keyed lookups by single-membership callers, per std-5). Two GET endpoints:

- **`GET /doc/:docId`** — snapshot. Returns the array of `AcWithVerification` from the service. Polled every 3s by the React tab.
- **`GET /doc/:docId/alignment-history?days=N`** — daily counts. `days` is clamped to `[7, 90]` so a misbehaving client can't ask for 9000.

The auth gate is the existing `sessionMiddleware`. The dev-bearer code path (`isDevMode() === true`) resolves to `dev@memex.ai` and works against `mindset-prod`/`dev/personal` via `ensureDevMemberships`. Multi-membership callers (the dev user is one) must hit the path-prefixed mount because the flat mount can't infer `currentMemexId` per std-5.

## Test-emission helper (`packages/server/bootstrap/ac-emit-vitest.ts`)

The half that lets a test in any Vitest-using codebase opt in to AC tracking with one line in the test body. Plus the wire format that any test framework can post to.

Shape:
```ts
import { tagAc } from '<wherever the helper lives in your repo>';

it('returns true when tokens available', () => {
  tagAc('mindset-prod/memex-building-itself/briefs/b-3/acs/ac-2');
  // ... test body ...
});
```

Mechanism: the helper registers `beforeEach`/`afterEach` hooks at module load. `beforeEach` stashes the current task in a module-level holder. `tagAc()` (called from the test body) reads that holder and attaches the AC uid to `task.meta`. `afterEach` reads `task.meta`, maps `task.result.state` to `pass`/`fail`/`error`, and POSTs the event to the destination derived from the canonical ref's namespace (`mindset-int/...` → `https://int.memex.ai`, `mindset-prod/...` → `https://memex.ai`). `MEMEX_TEST_EVENTS_URL` is available as an explicit opt-in override, but there is no default destination to fall through to — if a ref's namespace isn't in the routing table AND no override is set, the helper warns once and skips the emission. Emissions are best-effort: a network failure logs a warning and does NOT mask the test outcome.

Wire format (`POST /api/test-events`):
```json
{
  "ac_uid": "<namespace>/<memex>/briefs/<brief-handle>/acs/ac-<seq>",
  "status": "pass" | "fail" | "error",
  "test_identifier": "tests/foo.test.ts::it works",
  "duration_ms": 42,
  "commit_sha": "<optional>",
  "run_id": "<optional>"
}
```

The endpoint is unauthenticated in V0.0.1 — the spike is testing the loop end-to-end, not the security posture. Real shipping needs per-Memex scoping, a shared-secret or per-AC token, and rate limiting.

The Vitest helper is one reference implementation; other frameworks (Jest, pytest, Go's testing package) port the same beforeEach/tagAc/afterEach pattern over their equivalents. The `ac-emission` guidance topic (`packages/server/src/guidance/ac-emission.json`) tells AI coders how to wire it up per framework.

## React UI (`packages/admin/src/components/AcPanel.tsx`)

A fifth tab on the Brief view (`DocDocument.tsx`). Section layout reflects the audience-mismatch insight from Part I:

- **Scope** renders verbose. Each AC is a full row with its statement visible. Manager-authored, plain English, the statements ARE the content.
- **Implementation** renders compressed by default. The verified ACs collapse to a wall of small green pills (clickable to expand their statement); the failing/stale/untested ACs render as full rows. The visual mass of green is intentional — the hypothesis's "if everything's green, see 'everything's green' and move on" framing materialised in pixels.

Both sections lead with a green-first aggregate band: a chunky percentage number, a green progress bar, and a 30-day sparkline. The sparkline is hand-rolled SVG (`AcSparkline.tsx`, no charting dependency).

Three deliberate design moves worth knowing about when you touch this component:

1. **Framing line at the top of the tab.** A permanent header that anchors the novel mental model — tests as ongoing alignment-with-intent, not just code-correctness. The audience hasn't seen this paradigm before, so the data alone won't communicate it; the framing line does.
2. **Status labels stay familiar** (`verified` / `failing` / `untested` / `stale`). New jargon would lose the viewer entirely. The framing line + the section subtitles ("what your team committed to deliver", "how the codebase makes scope true") carry the conceptual novelty without forcing it into the status chips.
3. **No alarmist colour.** Failing ACs are clearly distinguishable from verified ones but they don't get red borders, warning icons, or "ATTENTION" framing. The whole tab is designed to be a place the manager *wants* to come back to. Green is the headline; failures are information, not panic.

The `investigate →` link on a failing AC drops the AC's ref into the embedded chat's context (via `addContextChip`) so the manager can ask questions about it. Phase 2 wires the agent to investigate proactively; phase 1 just routes the manager toward the conversation channel that already exists.

## Real-time updates: polling, not SSE

The tab polls `GET /acs/doc/:docId` and `GET /acs/doc/:docId/alignment-history` every 3 seconds while it's visible. Polling stops automatically when the tab is hidden via the Page Visibility API, so a backgrounded tab doesn't burn cycles. Latency-to-fresh: 0–3s when visible, instant on tab-show.

This is a deliberate phase-1 choice over SSE. The codebase already has SSE infrastructure (`docEventsRouter` + `bus.ts`) and `test_events` could be wired onto it. But that requires resolving brief → memex per event (since `test_events` is cross-tenant with no `memex_id` column), routing the test-events POST through `mutate()`, and adding a per-brief SSE channel for the tab to subscribe to. Real work. Polling at 3s hits the user-stated tolerance ("2–5 seconds is fine") today.

When this graduates, the upgrade is back-end-only: route emits onto the bus, new SSE endpoint streams `{briefId}` notifications, the React component swaps `setInterval` for `EventSource`. The data shape doesn't change.

## What still doesn't exist (deliberate gaps for V0.0.1)

- **No agent investigation.** A failing AC's "situation report" — the agent's classified cause + recommended fix from Part I — isn't built yet. Phase 2.
- **No per-customer opt-in for emission auth or rate-limiting.** `POST /api/test-events` accepts any payload with the right shape. Will need per-Memex scoping + shared secret + rate limit before any non-internal codebase emits.
- **No staleness configurability.** `STALE_THRESHOLD_DAYS = 7` is hardcoded. Will be per-Memex once we see what the right number is in practice.
- **No historical AC status reconstruction in the sparkline.** ACs currently `rejected` or `superseded` are excluded from the historical `total` even on days when they were `active`. Acceptable for V0.0.1; needs a status-event log to fix properly.
- **No coverage staleness alert.** The hypothesis's "AC sitting active for N days with no emission" guard isn't implemented yet; the workspace surfaces staleness per-AC visually but doesn't notify or escalate.
- **No pre-commit gate.** The "AI build session's PR manifest must include a test emitting each promised AC's UID" guard from the failure-modes section isn't wired into CI yet. The schema and emission path support it; the gating script doesn't exist.

## Where to look if you're changing something

| You want to change… | Look here |
| --- | --- |
| The AC schema or a new column | `packages/server/drizzle/0061_add_acs.sql` + `packages/server/src/db/schema.ts` |
| The verification state derivation | `packages/server/src/services/acs.ts` — `deriveVerificationState` |
| The staleness threshold | `STALE_THRESHOLD_DAYS` in the same file |
| The sparkline query | `listAcAlignmentOverTime` in the same file |
| The tab UI | `packages/admin/src/components/AcPanel.tsx` |
| The sparkline rendering | `packages/admin/src/components/AcSparkline.tsx` |
| The tab registration | `packages/admin/src/pages/DocDocument.tsx` — `tabs` array |
| The Vitest emission helper | `packages/server/bootstrap/ac-emit-vitest.ts` |
| The emission wire format / endpoint | `packages/server/src/routes/test-events.ts` |
| What AI coders are told about emission | `packages/server/src/guidance/ac-emission.json` |
| Agent-side tool definitions for ACs | `packages/server/src/agent/tool-specs.ts` (`create_ac`, `list_acs`, `get_ac`, `update_ac`, `delete_ac`, `link_ac_to_decision`) |
| The tool manifest the React UI's Init Prompt renders | `packages/shared/src/tool-manifest.ts` (rebuild with `pnpm --filter @memex/shared build` after edits) |
