// Default facet vocabulary (spec-340 t-2 / dec-7).
//
// The closed v1 set of 16 cross-cutting practice areas, seeded per organization
// at provisioning. Each org gets its own editable copy; these are the product
// DEFAULTS, not a global shared set. The `description` is the load-bearing field:
// it is the rubric the classifier reads to decide whether a clause GOVERNS the
// facet (sets a rule about it) versus merely MENTIONS it, and to disambiguate the
// confusable pairs (security vs api-design, architecture vs code-style, …).
// Precision is improved at the SOURCE here (dec-3), so each description draws the
// boundary against its nearest neighbour.
//
// PORTABILITY (std-22): the vocabulary + descriptions are product-generic — no
// language, framework, file path, tool, or tenant specifics. They apply to any
// codebase a Memex sits on.

export interface DefaultFacet {
  /** Stable slug — the code/prompt/LLM anchor and the pill label by default. */
  readonly key: string;
  /** Renameable display label. */
  readonly name: string;
  /** The disambiguating classifier rubric (governs-vs-mentions + nearest-neighbour boundary). */
  readonly description: string;
}

export const DEFAULT_FACETS: readonly DefaultFacet[] = [
  {
    key: "test-coverage",
    name: "Test coverage",
    description:
      "Unit and service/integration tests that assert a unit of code behaves as specified. Governs a clause only when it sets a rule about writing, structuring, or requiring such tests (coverage thresholds, test-first, what must be tested) — not when it merely notes that something was tested. Distinct from e2e-testing, which exercises whole assembled flows rather than isolated units.",
  },
  {
    key: "e2e-testing",
    name: "End-to-end testing",
    description:
      "End-to-end / user-facing-flow testing that drives the assembled product the way a user would (e.g. browser journeys). Governs a clause that requires or shapes such journeys for user-facing changes. Distinct from test-coverage (isolated unit/service tests) and from post-deploy-smoke (which runs against a deployed environment, not the pre-merge build).",
  },
  {
    key: "post-deploy-smoke",
    name: "Post-deploy smoke",
    description:
      "Verification that runs against a live, deployed environment to confirm a release is healthy. Governs a clause mandating smoke checks or live verification after a deploy. Distinct from e2e-testing, which runs pre-merge against the build rather than against the deployed environment.",
  },
  {
    key: "deploy-release",
    name: "Deploy & release",
    description:
      "How software is promoted and released to an environment: branch-to-environment mapping, release gates, rollout, and rollback. Governs a clause about the deploy/release procedure itself. Distinct from ci-pr-process (the pre-merge pipeline) and post-deploy-smoke (verification after the release lands).",
  },
  {
    key: "security",
    name: "Security",
    description:
      "Authorization, tenancy isolation, authentication, secret handling, and input validation. Governs a clause that sets a rule protecting data or access (who may see a resource, how tenants are isolated, how secrets are stored, how input is validated). When an interface-shape rule exists for a security reason (e.g. return 404 not 403 to avoid leaking existence), prefer security over api-design.",
  },
  {
    key: "architecture",
    name: "Architecture",
    description:
      "System and module structure, boundaries, and design patterns — how components are separated and how they communicate. Everyday work counts: creating a new module or file, adding to what a module exposes to its callers, or moving code from one place to another. Governs a clause about where logic belongs or how pieces fit together. Distinct from code-style, which is about local conventions (naming, formatting, typing) rather than structural decomposition.",
  },
  {
    key: "code-style",
    name: "Code style",
    description:
      "Local code conventions: naming, formatting, lint rules, typing idioms, and how code is laid out inside a file. Governs a clause prescribing how code is written at the line or file level. Where a rule is about structure or placement — what a module offers its callers, where logic lives, or which file something belongs in — prefer architecture; code-style keeps only how code is written inside a file.",
  },
  {
    key: "db-migrations",
    name: "Database & migrations",
    description:
      "Database schema and the migrations that change it: tables, columns, indexes, constraints, row-level security, and backfills. Governs a clause about schema shape or how a schema change is authored and applied. Distinct from api-design, which is about external contracts rather than persistence.",
  },
  {
    key: "api-design",
    name: "API design",
    description:
      "The shape and contract of an interface other code or clients call: endpoints, request/response shapes, status codes, versioning, and backward compatibility. Governs a clause about that contract. When a status-code or shape rule is chosen for a security reason, prefer security.",
  },
  {
    key: "observability",
    name: "Observability",
    description:
      "Error handling, logging, metrics, tracing, and the structured signals an operator reads to understand a running system. Governs a clause about how failures are surfaced or how activity is recorded for diagnosis. Distinct from post-deploy-smoke (a one-time verification step) — this is ongoing instrumentation.",
  },
  {
    key: "performance",
    name: "Performance",
    description:
      "Latency, throughput, resource use, and the budgets or limits that bound them. Governs a clause that sets a performance constraint or requires a hot path stay cheap. Not every mention of speed — only rules that bound or require performance characteristics.",
  },
  {
    key: "accessibility",
    name: "Accessibility & design system",
    description:
      "Conformance to accessibility and design-system standards so the product is usable by everyone: semantic markup, contrast, keyboard navigation, and component reuse. Governs a clause prescribing such conformance. Distinct from code-style, which is about code conventions rather than the rendered experience.",
  },
  {
    key: "ci-pr-process",
    name: "CI & PR process",
    description:
      "The pre-merge pipeline and contribution process: required checks, branch and commit conventions, and review/merge rules. Governs a clause about how a change gets reviewed and merged. Distinct from deploy-release, which promotes an already-merged change to an environment.",
  },
  {
    key: "documentation",
    name: "Documentation",
    description:
      "Human-readable docs that accompany the code: READMEs, changelogs, runbooks, and reference guides. Governs a clause requiring or shaping such documentation. A clause that merely IS documentation does not count — it must set a rule about producing or maintaining docs.",
  },
  {
    key: "dependencies",
    name: "Dependencies",
    description:
      "Third-party packages and their lifecycle: adding, pinning, upgrading, and single-version discipline across a workspace. Governs a clause about how external dependencies are chosen or managed. Distinct from architecture, which is about internal structure.",
  },
  {
    key: "feature-flags",
    name: "Feature flags & rollout",
    description:
      "Gated rollout and user migration: flags, staged enablement, and moving users from old to new behavior. Governs a clause about controlling the exposure of a change or migrating users. Distinct from deploy-release, which ships the code rather than gating who sees it.",
  },
];
