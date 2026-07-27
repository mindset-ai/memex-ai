# CLAUDE.md - Memex

This file is a pointer. The system of record is Memex itself.

## Where Memex lives

**This codebase's Memex is `mindset-prod/memex-building-itself`** — <https://memex.ai/mindset-prod/memex-building-itself>. Prod is `memex.ai`, staging is `int.memex.ai`, and each serves the app, the API and `/mcp` off the same host. Full topology: std-9. (The old `mindset-int/memex-app` workspace is read-only history.)

## How to orient (every session)

Memex hosts the Briefs, Standards, decisions, and tasks that describe this codebase. **The Memex MCP tools are your primary source of truth — not this file.**

```
mcp__memex__search_memex({memex: "mindset-prod/memex-building-itself", query: "<topic>"})
mcp__memex__list_docs({memex: "mindset-prod/memex-building-itself", docType: "standard"})
mcp__memex__get_doc({ref: "mindset-prod/memex-building-itself/standards/std-N"})
```

`search_memex` is semantic + FTS across all Briefs, Standards, and Decisions. Filter with `kind: "standard"` for rules, `kind: "decision"` for prior reasoning. When you're about to claim a fact — schema shape, route surface, auth flow, deployment topology, agent behaviour — search Standards first.

## Standards index

<!-- BEGIN generated: standards-index -->
| Standard | Covers |
|---|---|
| std-1 | Namespace / org / memex are three distinct concepts — plus user-facing vocabulary and handle conventions (`b-N` / `doc-N` / `std-N` / `s-N` / `dec-N` / `t-N` / `c-N`). |
| std-2 | Tenant routing is path-based on the apex domain — never subdomains. |
| std-3 | Namespace slug allocation (format, reserved list, rate limits, rename cooldown). |
| std-4 | Org membership grants access to every Memex in the org (v1 access model). |
| std-5 | No silent namespace default — ambiguous MCP / middleware calls error. |
| std-6 | Domain-based auto-join requires explicit user consent. |
| std-7 | Unauthorized resource access returns 404, not 403. |
| std-8 | Every mutation goes through `mutate()` and emits on the unified bus (real-time SSE). |
| std-9 | Infrastructure: int + prod GCP projects (Cloud Run, Cloud SQL, buckets, secrets, DNS) + local development. |
| std-10 | Canonical URL paths for Memex entities (the `ref` grammar). |
| std-11 | AI agent: direct Anthropic SDK on server, LangGraph in React UI. |
| std-12 | Service architecture — bounded components and how they wire. |
| std-13 | Native authentication: hand-rolled JWT + scrypt + auth_tokens + Postmark. |
| std-14 | Per-domain debug logging convention (`packages/server/.logs/<domain>.log`). |
| std-15 | Agent prompts live in `packages/server/src/agent/phases/` markdown, never inline in code. |
| std-16 | The coding-agent tool contract has one source — the `@memex/shared` manifest. |
| std-17 | Smoke tests are mandatory and run against live envs — int after every deploy, green before prod. |
| std-18 | Spec anatomy — the lens set every Spec carries: core lenses (Overview, Design & UX, Architecture & Security) always present; adaptive lenses (Operations, …) added when the work earns them. Decisions and ACs are primitives, not prose sections. |
| std-19 | Specs are SDD's canonical artifact — every unit of work is a Spec; "Spec" is the noun. |
| std-20 | Spec-Driven Development — drift is the enemy; the Spec is a living node in a knowledge map. |
| std-21 | Branch structure — `develop` integrates work; `main` is the production line (releases land as a **merge commit** via the develop→main PR — GitHub's PR surface can't fast-forward, cl-50; the content invariant is `git log develop..main --no-merges` empty, not SHA-identity; branch-bound deploy targets, main-only licence carve-out). |
| std-22 | Everything we ship runs against arbitrary codebases — portable artifacts (prompts, scaffold prose, Prompt Buttons, Init Prompts, in-repo tools) assume no language, framework, layout, file paths, or tooling. |
| std-23 | Prompt Buttons are the standard human→agent handoff — prompt prose lives in the Scaffold (`scaffold-data.ts`), never inline; copy-to-clipboard; Org-extensible (append-only). |
| std-24 | One version per shared library across the pnpm workspace, enforced by `pnpm.overrides` (today: vitest, `@vitest/coverage-v8`, `@types/node`, `react`/`react-dom`, `typescript`; plus security-floor pins `esbuild`/`form-data`/`protobufjs`). Exact pins in each package's devDependencies; new dep families added to the root overrides. |
| std-25 | Every Spec classifies its work as fair-code (open core) or EE — the licence boundary is decided per-Spec, up front, not retrofitted. |
| std-26 | Deploying Memex follows one runbook — prerequisites, the int→prod sequence, and the gotchas that bite (the procedural sibling of std-9's topology). |
| std-27 | Charts & data-viz: one theme-aware palette + glass treatment — `useChartPalette()`/`insightsTheme` from `packages/ui/src/components/insights/theme.ts`, reserved hue semantics, translucent fills with crisp edges, integer count ticks, themed tooltips, noise excluded server-side. |
| std-28 | PR-gate e2e journeys are mandatory — every change that adds/alters a user-facing flow adds or extends a Playwright journey in `packages/ui/e2e`; journey work is part of EVERY Spec's lifecycle (surfaced in plan, delivered in build, gating verify); run `make e2e-cold` before opening every PR; the suite runs per-PR against a cold DB and is a required check on develop + main; path-based nav, seed via the env-gated test surface (no raw SQL). The merge-side sibling of std-17's post-deploy smoke rule. Authoring a journey + local-run gotchas (cold-DB `PGPASSWORD`, stale `@memex/shared` build, browser install): [`packages/ui/e2e/README.md`](packages/ui/e2e/README.md). |
| std-29 | Guide content (Specky) stays current with the UI it documents — drift flagged for retirement (spec-508 removed the voice guide + its content pipeline). |
| std-30 | All LLM access goes through the metering wrapper (`getAnthropicClient()` singleton) — the only sanctioned path; direct `new Anthropic(...)` construction is forbidden. |
| std-31 | No real person or customer names in this public Memex (it builds itself in the open). |
| std-32 | The activity contract — every activity-bearing table (`documents`/`acs`/`tasks`/`decisions`/`doc_sections`/`doc_comments`/`test_events`/`activity_log`) carries WHEN (`at`, the row's own timestamp) + WHO (`actor_user_id` + denormalised `actor_name`, stamped at write so a rename can't rewrite history) + HOW (`channel`) + WHAT-coarse (owning-spec ref); load-bearing fields are first-class columns, only decorative context lives in `metadata`/`payload`. Identity rides the explicit `RequestCtx` through `mutate()` (not AsyncLocalStorage); a missing channel is a visible defect, never a silent 'server'. The attribution sibling of std-8 (spec-122 dec-2). |
| std-33 | Embedding the guide SDK (Specky) — drift flagged for retirement (spec-508 deleted `packages/guide-sdk` and the /guide/v1 backend). |
| std-34 | No human-facing surface instructs an MCP-only step — signal the web↔MCP capability boundary in copy (the honest-CTA rule). |
| std-35 | Usage events / Mixpanel — the metering + product-analytics event recipe. |
| std-36 | Tenant RLS posture — `ENABLE` row-level security, never `FORCE`; `runWithMemexId` ALS sets `memex_id`; views are `security_invoker`. |
| std-37 | Test fixtures are isolated under parallel execution — per-worker-unique identifiers, poll for async writes, restore global stubs. |
| std-38 | In-app agents share one contract — same visual shell (`ChatPanel`), Memex-wide grounding, narrow per-mode authoring scope enforced server-side by a `MODE_TOOLS` allow-list, copyable handoff on refusal. |
| std-39 | Database hygiene — every DB interaction is reasoned about for cost, locks, and growth, not just correctness. Covers migrations, handlers, MCP tools, relays, cron, and the React UI's query/polling patterns. |
| std-40 | Plugins are the Claude-Code delivery vehicle — one plugin, one concern. Covers hooks (std-41), a bundled MCP server, or slash commands; excludes the `memex-ai` CLI credential installer. |
| std-41 | Hooks make capability a side effect of work you already do — use them sparingly, never for correctness. Six tests gate whether a hook is the right tool; correctness/security/mutation work belongs on the server (std-8). |
| std-42 | Desktop client (memex-clients) releases follow one runbook — signing on BOTH platforms, notarization, auto-update, and per-channel distribution. An unsigned build is a CI artifact only, never published. |
<!-- END generated: standards-index -->

If a Standard contradicts the code, the Standard is probably right and the code has drifted — flag it.

## Session-start commands

```bash
brew services start postgresql@16
pnpm install
pnpm --filter @memex/server db:migrate
make dev          # server + UI on THIS workspace's derived ports (it prints them)
make check        # offline guard battery — no DB, no network, ~1s
make affected     # which suites your diff actually needs (advisory)
make test         # full server suite
```

Ports and e2e database names are **derived per workspace** from a hash of its path
(`scripts/ci/workspace-alloc.mjs`), so parallel worktrees never collide. Never hardcode a
port — run `make dev` and read the ones it prints, or `node scripts/ci/workspace-alloc.mjs --all`.
Prove isolation with `make prove-concurrent`.

Local Postgres connection string: `postgresql://postgres:postgres@localhost:5432/memex` (full local-dev posture lives in std-9 §9).

## Repository shape

`packages/`: **server** (Hono API, Drizzle, auth, agent, MCP) · **ui** (React 19 + Vite) · **shared** (pure, imported everywhere) · **cli** (`memex-ai` installer) · **db-schema** (published standalone) · **extractor** · **ac-emit-vitest** (the AC emitter). Service architecture: std-12. For anything deeper, `ls` — a tree copied here goes stale.

## Licensing — open core + EE

Memex is [**fair-code**](https://faircode.io/). **The file path is the licence marker**: `.ee.` in a filename or `.ee` as a dirname means [Memex Enterprise License](LICENSE_EE.md); everything else is the [Sustainable Use License](LICENSE.md). Dev and testing are always free — only *production* use of EE files needs a licence.

Adding or removing the marker **re-licenses the file**, so treat it as deliberate, and give every Spec an explicit fair-code/EE call (std-25). PRs touching `.ee.` files need a signed CLA (`CONTRIBUTING.md`).

Full statement: `README.md` ("Where enterprise code lives") and `CONTRIBUTING.md`. Enquiries: [hello@memex.ai](mailto:hello@memex.ai).

## Mechanics the machines enforce

Each rule below has a check. Break one and the check tells you what to run — you shouldn't need to remember any of this.

| Rule | Check | Fix |
|---|---|---|
| The standards index above matches Memex | `make standards-check` (in `make check`) | `make standards-gen` |
| Your e2e run can't silently test another workspace's code | `scripts/ci/e2e-preflight.mjs` (auto, via `make e2e`/`e2e-cold`) | it prints the exact command |
| Two worktrees don't collide on ports or databases | `make prove-concurrent` | — |
| UI types are really checked (`tsc -b`, not the no-op `--noEmit`) | `make typecheck`, pinned by `spec-512-workspace-isolation` | — |
| Emitted tenant URLs are path-based (std-2) | `make check-url-shape` | — |
| Every mutation goes through `mutate()` (std-8) | `mutate-coverage.*` guards | — |
| No direct `new Anthropic(...)` (std-30) | `no-direct-anthropic` guard | use `getAnthropicClient()` |
| Every user-facing flow change has an e2e journey (std-28) | `make e2e-cold` before every PR | — |

`make check` runs the offline battery (no DB, no network, ~1s). `.husky/pre-push` runs lint + typecheck + unit tests.

## When in doubt

1. Search Memex first (`search_memex`).
2. Read the relevant Standard before reading code.
3. Read code before asking the user.
4. If your conclusion conflicts with a Standard, surface that — don't paper over it.
