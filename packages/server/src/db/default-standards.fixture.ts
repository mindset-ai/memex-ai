/**
 * Default Standards — golden seed fixture (spec-184).
 * ---------------------------------------------------------------------------
 * The six portable, best-practice Standards seeded into every new PERSONAL Memex
 * so a brand-new user lands with a non-empty Standards list that (a) shows how we
 * think you should work with Memex, (b) models what a well-shaped Standard looks
 * like, and (c) gets applied while they work their first Spec.
 *
 * This file is the SINGLE source of seed content (spec-184 dec-5 / ac-16). The
 * verbatim wording was reviewed and approved as doc-6
 * (mindset-prod/memex-building-itself/docs/doc-6) before being encoded here.
 *
 * seedDefaultStandards(memexId) (services/default-standards.ts, spec-184 t-2) maps
 * each entry through the existing clause-first standard primitives:
 *     createDocDraft(memexId, title, "", "standard")   // born sectionless (spec-161)
 *       → for each section: addSection(memexId, docId, sectionType, <seed>, title)
 *           → addClausesToSection(memexId, sectionId, clauses)   // content = join of clauses
 * Each section therefore renders clause-first (cl-N handles), exactly like the
 * reference standard std-1 — the shape we're teaching by example.
 *
 * PORTABILITY CONTRACT (std-22 / spec-184 ac-17) — these Standards are applied to a
 * stranger's codebase, so the clause text below MUST NOT name: a file path or layout,
 * a language or framework, a test runner / build tool / package manager, a
 * project-specific symbol, or a `std-N` handle. Cross-references say "search this
 * Memex's Standards" rather than citing a handle. The only product specifics it leans
 * on are Memex's own universal surface — Specs, Standards, decisions, acceptance
 * criteria, the draft→specify→build→verify→done phases, and search — which every Memex
 * user shares. The default-standards.portability.test.ts (t-5) enforces this.
 *
 * Source lineage (NOT shipped in the portable text): 1 ← std-20 (+ std-19);
 * 2 ← std-18; 3 ← decisions-vs-tasks discipline; 4 ← std-17; 5 ← universal testing
 * practice; 6 ← std-7.
 */

/** One clause-first section of a default Standard. `clauses` become `cl-N` rows; the
 *  section's rendered `content` is their ordered join. */
export interface DefaultStandardSection {
  /** Free-form section_type slug — `description` | `rule` | `rationale` | `scope`. */
  sectionType: string;
  /** Human-visible section heading. */
  title: string;
  /** One self-contained clause body per element, in display order. */
  clauses: string[];
}

/** A default Standard: a docType='standard' document built from these sections. */
export interface DefaultStandard {
  /** Stable slug for logs/tests — NOT written to any row (the std-N handle is minted). */
  key: string;
  /** The Standard's title. */
  title: string;
  /** Ordered sections. Default shape is Description (optional) + Rule + Rationale + Scope. */
  sections: DefaultStandardSection[];
  /**
   * Which job this default does in the starter set (spec-184 ac-4 / ac-5):
   *   'methodology'  — teaches how to work with Memex (the agent surfaces these while
   *                    shaping a Spec); satisfies ac-4.
   *   'code-example' — governs the user's OWN code (not Memex process); satisfies ac-5.
   * The set ships >=1 of each. Metadata only — NOT written to any seeded row.
   */
  category: "methodology" | "code-example";
}

export const DEFAULT_STANDARDS: readonly DefaultStandard[] = [
  // 1 ─────────────────────────────────────────────────────────────────────────
  {
    key: "spec-driven-development",
    category: "methodology",
    title: "Spec-Driven Development — drift is the enemy",
    sections: [
      {
        sectionType: "description",
        title: "Description",
        clauses: [
          `The durable unit of work is the living Spec — written against, kept true, and verified — not a document written after the fact.`,
        ],
      },
      {
        sectionType: "rule",
        title: "Rule",
        clauses: [
          `Treat the Spec as the durable unit of work: a living, continuously-reconciled record of purpose, decisions, acceptance criteria, and tasks that you work *against* — not something written up after the code.`,
          `Use "Spec" as the canonical noun for a unit of work; every initiative is a Spec, and the Spec is the source of truth for what is being built and why.`,
          `Name drift — the gap between what the Spec says and what the system does — as the enemy; every other rule here exists to detect or prevent it.`,
          `Keep decisions, acceptance criteria, and tasks as typed primitives, not prose checkboxes; the narrative summarises them, it never replaces them.`,
          `Move a Spec through its phases in order — draft → specify → build → verify → done — and let the phase decide what work is legal now: shape and decide in specify, derive and build tasks in build, check against the running system in verify.`,
          `Find work by searching and traversing the knowledge map — by what a thing is *about* and what it *relates to* — never by remembering where a file lives; search existing Specs, Standards, and prior decisions before claiming a fact or starting new work.`,
          `Let the Spec survive the work: once done it freezes as the durable record of what was promised, decided, shipped, and verified.`,
        ],
      },
      {
        sectionType: "rationale",
        title: "Rationale",
        clauses: [
          `Static specs drift because nothing checks them against the code; a living Spec is reconciled continuously, so it stays trustworthy instead of going stale and then ignored.`,
          `This matters more with AI agents than with people: an agent carries no memory between sessions, so the Spec is the context it re-enters work against — and a stale Spec makes a locally-correct agent ship globally-wrong code.`,
          `Typed primitives plus per-criterion verification are what let the *system*, not human diligence, keep intent and code aligned.`,
          `One living Spec replaces ticket sprawl, a design doc, a requirements doc, and a post-mortem — one artifact doing several jobs, with no lossy hand-off between planning and building.`,
        ],
      },
      {
        sectionType: "scope",
        title: "Scope",
        clauses: [
          `Applies to any multi-file or multi-step change, anything that depends on a resolved decision, and anything that carries verification risk.`,
          `Escape hatch: a one-line fix, a dependency bump, a typo, a trivial refactor needs none of this — ship it and move on. Forcing the full discipline onto trivial work is its own failure mode, because it trains people to route around the system.`,
        ],
      },
    ],
  },

  // 2 ─────────────────────────────────────────────────────────────────────────
  {
    key: "how-to-shape-a-spec",
    category: "methodology",
    title: "How to shape a Spec",
    sections: [
      {
        sectionType: "description",
        title: "Description",
        clauses: [
          `Shape a Spec from the lenses the work actually needs — light by default, deeper only where the work earns it.`,
        ],
      },
      {
        sectionType: "rule",
        title: "Rule",
        clauses: [
          `Shape a Spec from lenses, not a fixed template; select the lenses the work in front of you actually needs.`,
          `Always include an Overview: the problem, the context (why now), the dependencies, and what is out of scope.`,
          `Include a Design & UX lens whenever the work touches a user- or caller-facing surface; if it touches none, say so ("Design & UX: n/a — no user-facing surface").`,
          `Include an Architecture & Security lens whenever the work changes system structure, data, integration points, or trust boundaries; if there is no new surface, name it ("Security: n/a — no new access control or external input").`,
          `Add an Operations lens when the work touches deploys, migrations, performance, or monitoring; omit it when it does not.`,
          `Mark an irrelevant lens "n/a — <reason>" rather than dropping it silently or leaving an empty heading; a genuinely trivial Spec may be Overview-only.`,
          `Keep decisions and acceptance criteria as primitives, never as authored "Decisions" or "Acceptance Criteria" prose sections; when a choice point appears in the narrative ("we could do X or Y"), record a decision instead of writing a paragraph.`,
          `Be concrete: name the real entities the work touches; ground architectural claims in the current source rather than from memory.`,
          `Enumerate, don't summarise: the Spec is the source of the work at the specify→build hand-off, so anything omitted here is work missed later.`,
          `Stay light by default; reach for depth only where the work earns it.`,
        ],
      },
      {
        sectionType: "rationale",
        title: "Rationale",
        clauses: [
          `One-size-fits-all headings make a one-file refactor and a brand-new surface look identical, and train people to fill in boilerplate; selecting lenses keeps each Spec shaped to its real risk.`,
          `An "n/a — reason" is a real answer that tells the next reader the question was considered; an empty forced heading just looks forgotten.`,
          `Concrete, enumerated, code-grounded plans are what let the next person (or agent) derive a task directly from the Spec without re-deciding anything.`,
        ],
      },
      {
        sectionType: "scope",
        title: "Scope",
        clauses: [
          `Applies when expanding a skeletal Spec (just an Overview) into a planning document ready for decisions and build.`,
          `Does not govern how decisions get resolved, how tasks are decomposed, or the verification approach — those are separate steps with their own rules.`,
        ],
      },
    ],
  },

  // 3 ─────────────────────────────────────────────────────────────────────────
  {
    key: "resolve-decisions-before-tasks",
    category: "methodology",
    title: "Resolve decisions before you create tasks",
    sections: [
      {
        sectionType: "description",
        title: "Description",
        clauses: [
          `A task built over an unresolved decision is a guess; resolve the question first.`,
        ],
      },
      {
        sectionType: "rule",
        title: "Rule",
        clauses: [
          `Resolve every open decision a piece of work depends on before you turn that work into tasks.`,
          `Treat a task that names an open question as a decision in disguise — surface it as a decision and resolve it; don't bury the question inside scoped work.`,
          `Record each decision with its options, its trade-offs, and the rationale for the choice, so the reasoning (including the roads not taken) survives.`,
          `Reflect a resolved decision in the narrative before moving on; if a decision isn't visible in the prose, it hasn't truly been made.`,
          `After resolving a decision, capture the concrete, checkable claim(s) it commits you to as acceptance criteria — the decision says *what you chose*, the criteria say *what proves you honoured it*.`,
        ],
      },
      {
        sectionType: "rationale",
        title: "Rationale",
        clauses: [
          `A task created over an unresolved decision is a guess; building it spends effort on a choice nobody has actually made, and the rework is expensive.`,
          `Decisions captured with their rejected alternatives are the most valuable archaeology a future reader — a new joiner, or an agent re-entering the work — can have; they answer "why is it like this?".`,
          `Resolving first is what lets planning and building be handed between people or agents without re-litigating settled questions.`,
        ],
      },
      {
        sectionType: "scope",
        title: "Scope",
        clauses: [
          `Applies to any decision whose outcome changes the shape of the work — architecture, data model, user-facing behaviour, or an external contract.`,
          `A reversible, low-stakes choice discovered mid-build needn't block work: capture it as a decision when it appears and keep going. Don't manufacture decisions for choices with one obvious answer.`,
        ],
      },
    ],
  },

  // 4 ─────────────────────────────────────────────────────────────────────────
  {
    key: "verify-acs-against-running-behaviour",
    category: "code-example",
    title: "Verify every acceptance criterion against running behaviour",
    sections: [
      {
        sectionType: "description",
        title: "Description",
        clauses: [
          `"Done" is a per-criterion verdict with evidence, not a vibe.`,
        ],
      },
      {
        sectionType: "rule",
        title: "Rule",
        clauses: [
          `Verify each acceptance criterion individually, against the running system's actual behaviour — not against the diff, the types, or the author's confidence.`,
          `Treat "done" as a per-criterion verdict backed by evidence (a test that runs, a path you exercised), never a feeling.`,
          `Exercise the real path end to end before calling it verified; a green suite that runs only against stand-ins is necessary but not sufficient.`,
          `Where a running or deployed environment exists, verify against it, not only on the author's machine.`,
          `Reopen the work when a criterion fails or later breaks; a criterion that was green and goes red is drift, and drift reopens the Spec.`,
        ],
      },
      {
        sectionType: "rationale",
        title: "Rationale",
        clauses: [
          `Suites pass against stubs and mocks; only exercising the running system catches the wiring, configuration, data, and integration failures that don't show up in isolation.`,
          `Verifying criterion-by-criterion turns "is it done?" from a judgement call into a checklist with evidence — which is what makes "done" trustworthy to someone who didn't write the code.`,
          `Catching a failure at verification is far cheaper than catching it as a user report.`,
        ],
      },
      {
        sectionType: "scope",
        title: "Scope",
        clauses: [
          `Applies to every acceptance criterion on a Spec that reaches the verify phase.`,
          `A criterion that genuinely can't be exercised (e.g. a pure documentation outcome) is verified by inspection — say so explicitly rather than marking it tested.`,
        ],
      },
    ],
  },

  // 5 ─────────────────────────────────────────────────────────────────────────
  {
    key: "every-change-ships-with-a-test",
    category: "code-example",
    title: "Every behavioural change ships with a test that verifies it",
    sections: [
      {
        sectionType: "description",
        title: "Description",
        clauses: [
          `If behaviour changed, a test that would fail without the change ships with it.`,
        ],
      },
      {
        sectionType: "rule",
        title: "Rule",
        clauses: [
          `Accompany every change in behaviour with a test that fails before the change and passes after it.`,
          `Cover the new or changed path at the tier that actually exercises the behaviour (the level where it's observable), not just the cheapest tier to write.`,
          `Assert the behaviour, not the implementation, so a valid refactor doesn't break the test.`,
          `When you fix a bug, add a regression test that reproduces the bug and then proves the fix.`,
          `A change with no test — or a test that cannot fail — does not count as done.`,
        ],
      },
      {
        sectionType: "rationale",
        title: "Rationale",
        clauses: [
          `A test written alongside the change pins the intended behaviour so later edits can't silently break it; it is the cheapest insurance against regression.`,
          `Tests that assert implementation detail rot on every refactor and train the team to delete them; behaviour-level tests survive and keep paying off.`,
          `A bug with no regression test will come back; the test is what makes the fix permanent.`,
        ],
      },
      {
        sectionType: "scope",
        title: "Scope",
        clauses: [
          `Applies to any change that adds, removes, or alters observable behaviour.`,
          `Does not require tests for changes with no behavioural surface — formatting, comments, copy. A spike or prototype may defer tests, as long as the version that ships to production does not.`,
        ],
      },
    ],
  },

  // 6 ─────────────────────────────────────────────────────────────────────────
  {
    key: "unauthorized-returns-not-found",
    category: "code-example",
    title: `Unauthorized access returns "not found", not "forbidden"`,
    sections: [
      {
        sectionType: "description",
        title: "Description",
        clauses: [
          `Don't confirm a resource exists to someone who isn't allowed to see it.`,
        ],
      },
      {
        sectionType: "rule",
        title: "Rule",
        clauses: [
          `Respond to a request for a resource the caller isn't authorised to see with "not found" (HTTP 404), not "forbidden" (HTTP 403).`,
          `Make a genuinely-missing resource and an access-denied resource return the identical response, so the two are indistinguishable from the outside.`,
          `Apply this to every resource scoped to a tenant, account, or owner — the very existence of such a resource is privileged information.`,
        ],
      },
      {
        sectionType: "rationale",
        title: "Rationale",
        clauses: [
          `Returning "forbidden" confirms that a resource exists, which lets an attacker enumerate valid identifiers, names, or accounts just by watching the forbidden-vs-not-found boundary.`,
          `Collapsing the two responses removes that side channel at no cost to a legitimate caller, who sees the same thing either way.`,
        ],
      },
      {
        sectionType: "scope",
        title: "Scope",
        clauses: [
          `Applies to authorization checks on tenant- or owner-scoped resources.`,
          `Does not apply to authentication failures — a missing or invalid credential legitimately returns "unauthorized" (HTTP 401) — nor to validation errors on a resource the caller is allowed to see.`,
          `If a system has no multi-tenant or per-owner resources, this Standard is informational; adapt it to your access model or remove it.`,
        ],
      },
    ],
  },
] as const;

/** The number of default Standards seeded into every new personal Memex (spec-184 ac-7). */
export const DEFAULT_STANDARDS_COUNT = DEFAULT_STANDARDS.length;
