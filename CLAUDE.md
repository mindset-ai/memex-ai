# CLAUDE.md - Memex App

This file is a pointer. The system of record is Memex itself.

## Where Memex lives (prod is live as of 2026-05-24)

The platform is deployed and the workspace has moved. INT is no longer the source of truth.

| Surface | URL |
|---|---|
| **Production app** (React UI + API + MCP) | `https://memex.ai/<namespace>/<memex>/...` |
| **Staging app (int)** | `https://int.memex.ai/<namespace>/<memex>/...` |
| **Marketing site** | `https://www.memex.ai/` |
| **MCP endpoint** (prod / int) | `https://memex.ai/mcp` · `https://int.memex.ai/mcp` |

**This codebase's Memex is now `mindset-prod/memex-building-itself`** (web: `https://memex.ai/mindset-prod/memex-building-itself`). It was migrated from the old `mindset-int/memex-app` on 2026-05-24 via direct SQL (b-65) — the memex was renamed (`memex-app` → `memex-building-itself`) and rehomed under the `mindset-prod` namespace, with all UUIDs and `b-N`/`std-N` handles preserved. The old INT workspace at `mindset-int/memex-app` remains readable for reference only; each INT doc carries a breadcrumb comment pointing at its PROD counterpart. Full infra + routing topology lives in std-9.

## How to orient (every session)

Memex hosts the Briefs, Standards, decisions, and tasks that describe this codebase. **The Memex MCP tools are your primary source of truth — not this file.**

```
mcp__memex__search_memex({memex: "mindset-prod/memex-building-itself", query: "<topic>"})
mcp__memex__list_docs({memex: "mindset-prod/memex-building-itself", docType: "standard"})
mcp__memex__get_doc({ref: "mindset-prod/memex-building-itself/standards/std-N"})
```

`search_memex` is semantic + FTS across all Briefs, Standards, and Decisions. Filter with `kind: "standard"` for rules, `kind: "decision"` for prior reasoning. When you're about to claim a fact — schema shape, route surface, auth flow, deployment topology, agent behaviour — search Standards first.

## Standards index

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
| std-19 | Specs are SDD's canonical artifact — every unit of work is a Spec; "Spec" is the noun. |
| std-20 | Spec-Driven Development — drift is the enemy; the Spec is a living node in a knowledge map. |
| std-21 | Branch structure — `develop` integrates work; `main` is the production line (fast-forward only, branch-bound deploy targets, main-only licence carve-out). |
| std-22 | Everything we ship runs against arbitrary codebases — portable artifacts (prompts, scaffold prose, Prompt Buttons, Init Prompts, in-repo tools) assume no language, framework, layout, file paths, or tooling. |
| std-24 | One version per shared library across the pnpm workspace, enforced by `pnpm.overrides` (today: vitest, `@vitest/coverage-v8`, `@types/node`). Exact pins in each package's devDependencies; new dep families added to the root overrides. |
| std-27 | Charts & data-viz: one theme-aware palette + glass treatment — `useChartPalette()`/`insightsTheme` from `packages/ui/src/components/insights/theme.ts`, reserved hue semantics, translucent fills with crisp edges, integer count ticks, themed tooltips, noise excluded server-side. |
| std-28 | PR-gate e2e journeys are mandatory — every change that adds/alters a user-facing flow adds or extends a Playwright journey in `packages/ui/e2e`; journey work is part of EVERY Spec's lifecycle (surfaced in plan, delivered in build, gating verify); run `make e2e-cold` before opening every PR; the suite runs per-PR against a cold DB and is a required check on develop + main; path-based nav, seed via the env-gated test surface (no raw SQL). The merge-side sibling of std-17's post-deploy smoke rule. |

If a Standard contradicts the code, the Standard is probably right and the code has drifted — flag it.

## Session-start commands

```bash
brew services start postgresql@16
pnpm install
pnpm --filter @memex/server db:migrate
make dev          # server (8080) + React UI (5173)
make test         # full server suite
```

Local Postgres connection string: `postgresql://postgres:postgres@localhost:5432/memex` (full local-dev posture lives in std-9 §9).

## Repository shape

```
packages/server/    Hono API, Drizzle ORM, auth, email, AI agent, MCP endpoint
packages/ui/     React 19 UI (Vite, TailwindCSS) — the "React UI"
packages/cli/       memex-ai npm package (MCP installer, zero-dep)
packages/extractor/ Code intelligence ingestion
packages/shared/    Shared types/utilities
scripts/deploy-config.sh    env-keyed deploy values (std-9 documents this)
Makefile / deploy.sh / docker-compose.yml / Rakefile
```

For deeper layouts inside any package, `ls` is the source of truth — replicating the tree here goes stale fast.

## Licensing — open core + EE (the `.ee` marker)

Memex is [**fair-code**](https://faircode.io/) (open core). Two licenses, and **the file path is the license marker** — there is no private fork, submodule, or build flag. EE = **Enterprise Edition** (the *Memex Enterprise License*).

| Scope | License | Production use |
|---|---|---|
| Default — everything else | [Sustainable Use License](LICENSE.md) | Free for internal-business / non-commercial / personal use |
| Files with **`.ee.` in the filename** or **`.ee` as a dirname** | [Memex Enterprise License](LICENSE_EE.md) | Requires a valid Memex Enterprise license |

```
packages/server/src/services/sso.ee.ts              # filename marker
packages/server/src/services/audit/.ee/recorder.ts  # dirname marker
packages/ui/src/components/.ee/RbacMatrix.tsx     # dirname marker
```

Rules to respect when working in this repo:

- **Either marker qualifies** — it's a file-path test, not a build flag. Single-file EE features use the `.ee.` filename; multi-file EE clusters use a `.ee/` directory. They're interchangeable.
- **Dev/testing is always free** — only *production* use of EE-marked files needs a license.
- **Don't move code across the line silently.** Adding `.ee.`/`.ee` re-licenses a file (and gates it commercially); removing it relicenses it as open core. Treat the marker as deliberate.
- **PRs touching `.ee.` files need a signed CLA** and prior coordination with Mindset — see `CONTRIBUTING.md` ("EE feature"). "Changes to `.ee.` files without a signed CLA" is on the won't-merge list.
- Branches other than `main` are not licensed; third-party components keep their original licenses.

Full statement lives in `README.md` ("Where enterprise code lives") and `CONTRIBUTING.md`. Licensing enquiries: [hello@memex.ai](mailto:hello@memex.ai).

## When in doubt

1. Search Memex first (`search_memex`).
2. Read the relevant Standard before reading code.
3. Read code before asking the user.
4. If your conclusion conflicts with a Standard, surface that — don't paper over it.
