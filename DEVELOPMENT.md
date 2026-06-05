# Memex — Developer & Architecture Guide

> This is the deep technical reference for people **working on Memex** — architecture, design decisions, local setup, testing, and deployment. New here? Start with the [README](README.md), then come back for the details.

Memex.AI is a multi-tenant platform for drafting and running **Specs** — living documents that capture decisions, open questions, and the tasks that flow from them. A Claude-powered agent works alongside you, both through the web chat panel and through MCP (Model Context Protocol), so the same Spec can be edited by a human in the React UI or by Claude Code via MCP.

Built on Hono, Drizzle ORM, React 19, and the Anthropic SDK.

> **Naming note:** the user-facing nouns are **Spec** and **Standard**. Under the hood, code, URLs, database tables, and generic MCP tools all use `doc` — so `doc-1` (or `std-1` for standards, or `spec-1` for Specs) is still the handle you pass around. Don't rename internal identifiers; do say "Spec" / "Standard" in anything a user sees.
>
> **Tenancy vocabulary (per dec-9 of doc-15):** the legacy `accounts` table is split into `namespaces` (global slug pool), `orgs` (org container), and `memexes` (workspaces). The canonical URL is path-based: `memex.ai/<namespace>/<memex>`. See `CLAUDE.md` for the full breakdown.

## Architecture

```
  React UI (memex.ai/<ns>/<mx>)         MCP Clients (Claude Code / Desktop)
                                        via `npx memex-ai` installer
       │                                     │
       │  REST + SSE (Bearer JWT)            │  Streamable HTTP (Bearer mxt_…)
       ▼                                     ▼
  ┌────────────────────────────────────────────────────────────┐
  │  Hono API Server                                           │
  │                                                            │
  │  memexResolver: /<namespace>/<memex>/ path → memex UUID    │
  │  session middleware: JWT → user + org membership check     │
  │                                                            │
  │  /api/<ns>/<mx>/docs, /decisions, /tasks, /comments, ...   │  Tenancy-scoped REST
  │  /api/docs, /api/decisions, …                              │  Same routers, flat (UUID lookups)
  │  /api/auth/*           (signup/login/magic-link/reset/SSO) │
  │  /api/orgs, /api/consent, /api/me, /api/invites, /api/team │  Caller-scoped tenancy + membership
  │  /api/<ns>/<mx>/llm/chat                (agent SSE)        │
  │  /api/<ns>/<mx>/docs/events/:docId      (real-time SSE)    │
  │  /api/cli/auth, /api/mcp/tokens         (device-flow)      │
  │  /api/share/:token                      (public share)     │
  │  /mcp                                   (MCP, mxt_ token)  │
  └──────────────────┬─────────────────────────────────────────┘
                     │
         Drizzle ORM │  Anthropic API (Claude Sonnet 4.5)
                     │  Postmark (email)
                     ▼
              PostgreSQL 16
              (local / Cloud SQL)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Server** | Node.js 22, TypeScript, Hono, Drizzle ORM, postgres-js |
| **React UI** | React 19, Vite, React Router, TailwindCSS 3.4, react-resizable-panels |
| **AI Agent** | `@anthropic-ai/sdk` (direct API, no framework), Claude Sonnet 4.5 |
| **Auth** | Hand-rolled HS256 JWT + scrypt + `auth_tokens` (verification / magic-link / reset); Google SSO optional |
| **Email** | Postmark (HTTP API), with Console and NotConfigured fallbacks |
| **Database** | PostgreSQL 16 (Homebrew locally, Cloud SQL in production) |
| **MCP** | `@modelcontextprotocol/sdk`, Streamable HTTP transport |
| **Deployment** | GCP Cloud Run (server), GCS + CDN (React SPA) |

### Project Structure

```
memex-app/
  packages/
    server/                    # Hono API + Drizzle ORM + Auth + Email + Agent + MCP
      bootstrap/               # install.sh / install.ps1 (served at /install.{sh,ps1})
      src/
        agent/                 # AI agent (direct Anthropic SDK, prompt caching, logging)
        routes/                # HTTP endpoints (docs, auth, orgs, consent, me, llm, cli-auth, mcp, ...)
          auth/                # Sub-routers: sso, password, magic-link, reset, session
        services/              # Business logic
          email/               # EmailSender abstraction (Console / Postmark / NotConfigured)
          shared/              # identifiers, sequence, blockers, slug, memex-ownership
        middleware/            # session.ts (JWT), memex-resolver.ts (path → memex), error-handler
        db/                    # Drizzle schema, connection, seed
        mcp/                   # MCP server + tool handlers + formatters
        __security__/          # Security hardening tests
        __perf__/              # Performance / concurrency tests
        __regression__/        # Regression tests (incl. tools-coverage parity)
        __e2e__/               # Cross-package HTTP-level tests
      drizzle/                 # Migration SQL files
    admin/                     # React 19 UI (Vite, TailwindCSS)
      src/
        pages/                 # BriefList, StandardList, DocDocument, SharedDocument,
                               # VerifyEmail, MagicLinkConsume, ResetPassword, InviteAccept,
                               # Onboarding, OrgConfiguration, SettingsTokens, Installation,
                               # InstallAuth, Backstage, DriftInbox, Decisions, Inbox, ...
        components/
          chat/                # ChatMarkdown, MDX widgets, ContextChipBar, ui-tools/
          account/             # SettingsTab, UsersTab, InvitesTab (internal dir name)
          ui/                  # Primitive components
          AuthContext.tsx      # Session JWT + user identity
          ThemeContext.tsx     # Dark/light mode (CSS classes on <html>)
          ChatContext.tsx      # Chat state + SSE + tool execution
          AppShell.tsx         # Header + nav shell
          DocumentShell.tsx    # 2-panel resizable layout for /docs/:id
          MemexSwitcher.tsx    # Multi-memex switcher
          OrgButton.tsx        # Org-level surface (replaces TeamButton)
          OrgConsentDialog.tsx # First-SSO domain-match consent prompt
          CreateOrgDialog.tsx  # Org-creation flow
          NewBriefModal.tsx
        hooks/useDocChangeStream.ts  # SSE subscription with auto-reconnect + debounce
        agent/                 # LangGraph StateGraph + clients (graph.ts, llm-client.ts, ...)
        api/                   # REST client, POST-based SSE client, types
                               # http.ts:tenantBase() builds the `/api/<namespace>/<memex>` prefix
    cli/                       # memex-ai npm package (zero-dep MCP installer)
    extractor/                 # Code-intelligence ingestion (repos, files, symbols)
    shared/                    # Shared types/utilities across packages
  docs/                        # Platform specs + whitepapers
  Makefile                     # Task runner (test, dev, deploy)
  deploy.sh                    # Top-level deploy orchestrator
```

## Key Design Decisions

### Multi-tenancy via Namespaces, Orgs, and Memexes

Per dec-9 of doc-15, tenancy is split across three tables:

- `namespaces` — global slug pool (one row per user, one per org); slugs match `^[a-z0-9][a-z0-9-]{0,38}$` and are case-insensitive.
- `orgs` — org container (membership, billing, admin, email-domain auto-grouping). Each org owns exactly one namespace.
- `memexes` — workspaces; each belongs to a namespace, with a per-namespace-unique slug.

Every document, decision, task, and comment is scoped to a memex via `memexId`. Users get a **personal memex** under their user namespace automatically, and any verified user can create orgs (subject to a 5-orgs-per-24h rate limit).

- The canonical URL is path-based: `memex.ai/<namespace>/<memex>` (per dec-3 / std-2). The apex root `memex.ai/` 301s to `www.memex.ai/`.
- `memexResolver` (`middleware/memex-resolver.ts`) parses `/<namespace>/<memex>/` off the URL path, looks up the memex, and stamps `currentMemexId` on the context. Unknown slugs → 404 (except `/api/health`).
- `sessionMiddleware` (`middleware/session.ts`) resolves the caller's org membership against the resolved memex; non-members get 404 (per std-7 — no enumeration leak).
- Handles like `doc-1`/`dec-1`/`t-1` are **per-memex**, not global — each memex has its own sequence.
- **React UI router:** the browser URL is path-based (`memex.ai/<namespace>/<memex>`). `api/http.ts:tenantBase()` parses `window.location.pathname` directly — no subdomain parsing, no membership lookup, the URL is the source of truth (per t-23 of doc-15).

### Native Auth (HS256 JWT + scrypt + email tokens)

No external auth service, no `jsonwebtoken` dependency, no bcrypt.

- **Sessions**: HS256 JWTs signed with `AUTH_JWT_SECRET` (≥32 chars in prod), 30-day TTL. Hand-rolled in `services/auth-jwt.ts` using only `node:crypto`.
- **Passwords**: scrypt + 16-byte salt; timing-safe compare. See `services/passwords.ts`.
- **Verification, magic-link, and password-reset flows** all share the `auth_tokens` table. Tokens are stored as SHA-256 hashes (never plaintext); each has a `purpose`, `expiresAt`, and single-use `consumedAt`.
- **Google SSO** (`routes/auth/sso.ts`) is optional — it upserts a user on first login (with no passwordHash) and issues a JWT the same way.
- **Dev bypass**: if no auth env vars are set, the session middleware falls back to a hardcoded `dev@memex.ai` user on a default dev memex — useful for local work without OAuth setup.

### Email via Postmark

`services/email/sender.ts` defines an `EmailSender` interface with three implementations:

- `PostmarkEmailSender` — activated when `POSTMARK_SERVER_TOKEN` + `EMAIL_FROM` are set. Production path.
- `ConsoleEmailSender` — prints messages to stdout. Default in local dev.
- `NotConfiguredEmailSender` — throws loudly if email is needed in prod but not configured.

Templates (verification, magic-link, reset, invite, domain-verification) live in `services/email/templates.ts`.

> **Postmark is approved (2026-05-05)** — sends to any recipient domain. Verify SPF/DKIM/DMARC alignment before relying on inbox delivery (Gmail/Outlook get strict). Route bounce/complaint webhooks into observability so deliverability regressions are caught early.

### Agent Architecture

The server-side agent uses the **direct Anthropic API** (no LangGraph, no Vercel AI SDK) for full prompt-caching control. See `docs/agentic-interface-spec.md` for the full analysis. The React UI client wraps that server endpoint in a **`@langchain/langgraph` `StateGraph`** that orchestrates the agent loop in the browser — a `createDoc` node for the creation phase plus one agent node per Spec lifecycle phase (`draftAgent` / `planAgent` / `buildAgent` / `verifyAgent` / `doneAgent`), each routing to a shared `tools` node. LLM round-trips still go through the server SDK so caching is preserved.

- **Model**: Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`)
- **Three cache breakpoints**: tool definitions (1h TTL), system prompt + document context (5m), conversation history (5m)
- **Phases**: `creation` (no docId, gathers info to call `create_doc`) and `document` (full context + mutation tools), with Spec lifecycle phases (`draft`/`plan`/`build`/`verify`/`done`) selecting the agent node in the document phase
- **Server tools**: Execute mutations via the service layer (update_section, resolve_decision, create_task, create_doc, etc.)
- **UI tools**: Forwarded to the frontend as SSE events (render_action_buttons, render_choices, render_confirmation, render_progress). The agent loop pauses; the user's click resumes it with a `tool_result`.
- **MDX widgets**: The agent writes `<DecisionCard id="dec-1" />` inline; the React UI renders them via `rehype-raw`.
- **Context chips**: Clicking sections/decisions/tasks adds focus chips to the chat, serialized as a `[Focus: ...]` prefix on the next user message.

### Real-Time Change Propagation

All document mutations — whether from the React UI, the AI agent, MCP clients, or the REST API — are propagated to connected clients in real time via Server-Sent Events.

```
Agent Chat ──┐                       ┌── React UI Client A (SSE subscription)
MCP Endpoint ┤── mutate() ──► Bus ──► SSE Endpoint ──┤
REST API ────┘  (services/mutate.ts) └── React UI Client B (SSE subscription)
```

1. Every write goes through `mutate()` (`services/mutate.ts`) — per std-8, this is the single sanctioned mutation wrapper.
2. `mutate()` publishes to the in-process bus (`services/bus.ts`) after the DB write commits.
3. SSE endpoints (`GET /api/<ns>/<mx>/docs/events/:docId` and `GET /api/<ns>/<mx>/docs/events`) push events to subscribed clients.
4. The `useDocChangeStream` React hook subscribes, debounces (200ms), and triggers a refetch.
5. Auto-reconnect with exponential backoff (1s → 30s).

**Per-document stream:** `DocDocument` subscribes to one doc's changes. **Global stream:** `BriefList` / `StandardList` / `DocumentList` / `DriftInbox` subscribe to all changes in the current memex — new Briefs / Standards from MCP or other clients appear automatically.

### SSE Streaming (POST-based)

The chat uses **POST-based SSE** via `ReadableStream`, not `EventSource`, because:
- `EventSource` is GET-only — can't send a request body.
- Auth headers (`Authorization: Bearer …`) need to ride the request.

The frontend parses the streaming body manually and yields typed `AgentEvent` objects.

### UI Tool Pause/Resume

When the agent calls a UI tool (e.g., a confirmation dialog):
1. The agent's assistant message with `tool_use` is persisted to the DB.
2. SSE closes.
3. User clicks a button in the chat UI.
4. New POST with `uiToolResult: { toolId, result }` resumes the loop.
5. Server loads conversation history (keeping the `tool_use`), appends a `tool_result`, continues.

**Gotcha**: when loading history for a normal (non-resume) request, dangling `tool_use` blocks (no matching `tool_result`) are stripped to avoid Anthropic API errors. See `toAnthropicMessages()` in `routes/llm.ts`.

### Theme System

Dark/light mode uses a custom `ThemeContext` with `.dark`/`.light` classes on `<html>`. **Tailwind's `dark:` variant is NOT used** — it doesn't generate reliably here. All theme-conditional styling uses `isDark` ternaries from `useTheme()`.

Markdown content styling is handled in `index.css` with `.dark .prose-dark` and `.light .prose-dark` selectors.

### Two-Panel Layout

Resizable via `react-resizable-panels`. Today's `DocumentShell` (under `/docs/:id`) is a 2-panel group with Chat on the left and the Canvas (DocDocument tabs + in-canvas outline aside) on the right:

| Panel | Default |
|-------|---------|
| Chat (left) | 22% |
| Canvas (right) | 78% |

The group ID (e.g., `memex-shell-v8` in `DocumentShell.tsx`) must be bumped when changing defaults to clear cached layouts in localStorage.

### Spec Creation via Chat

The "+ New Spec" flow on `SpecList`:
1. Opens `NewSpecModal` or clears chat and seeds a creation-phase conversation.
2. The agent asks for title, type, and purpose, then calls `create_doc`.
3. `SpecList` auto-refreshes via the global SSE change stream.

The `/api/<ns>/<mx>/llm/chat/create` endpoint handles the creation phase with no doc context.

## Prerequisites

- Node.js 22+
- pnpm
- PostgreSQL 16 (via Homebrew)

## Environment Variables

### Server (`packages/server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for the AI agent |
| `AUTH_JWT_SECRET` | Prod | ≥32-char secret for session JWTs (dev fallback provided) |
| `POSTMARK_SERVER_TOKEN` | Prod | Postmark server token (email) |
| `EMAIL_FROM` | Prod | `"Memex <no-reply@memex.ai>"` or similar |
| `GOOGLE_CLIENT_ID` | No | Enables Google SSO (optional) |
| `OAUTH_ENABLED` | No | Gates `/oauth/*` routes (`app.ts`) — leave unset to disable |
| `WAITLIST_DISABLED` | No | Set truthy to disable `POST /api/waitlist` |
| `OPENAI_API_KEY` | No | Standards embeddings (per std-9) |
| `COHERE_API_KEY` | No | Optional reranker for code search |
| `APP_BASE_URL` | No | Public base URL used by `services/shared/tenant-url.ts` (e.g. `https://memex.ai`) |
| `CLOUD_SQL_SOCKET` | No | Cloud Run-only — Unix-socket sidecar path for Cloud SQL |
| `DEBUG_AGENT` | No | Set to `0` to silence agent log |
| `MEMEX_OWN_NAMESPACE` | Prod | The namespace this server owns — `mindset-int` in int, `mindset-prod` in prod. The `POST /api/test-events` route reads this to reject events whose AC ref names a different namespace (the cross-namespace safety net per spec-90). When **unset**, the route fail-closes — every test-event POST returns 503. Local-dev devs running tests against a local Memex server must set this explicitly to opt in. Set automatically by `scripts/deploy-config.sh` per env and wired into Cloud Run via `packages/server/deploy.sh`. |

### React UI (`packages/ui/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_URL` | No | API base URL (defaults to `/api`, proxied to server in dev) |
| `VITE_GOOGLE_CLIENT_ID` | No | Enables Google SSO button (optional) |

When none of the auth env vars are set on the server, `sessionMiddleware` uses a hardcoded dev user — useful for local work without OAuth or email setup.

## Database Setup

> **IMPORTANT:** All development uses a local PostgreSQL instance via Homebrew. Never connect to the hosted/production Cloud SQL database for development work.

### First-time setup

```bash
brew install postgresql@16
brew services start postgresql@16

# Create the postgres role and memex database
psql -d postgres -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';"
psql -U postgres -d postgres -c "CREATE DATABASE memex;"
```

Local PostgreSQL on `localhost:5432` with user `postgres`, password `postgres`, database `memex`.

### Manage local PostgreSQL

```bash
brew services start postgresql@16    # Start
brew services stop postgresql@16     # Stop
brew services restart postgresql@16  # Restart
```

Reset the database completely:
```bash
rake db:nuke                         # Drops and recreates `memex`
pnpm --filter @memex/server db:migrate
```

## Getting Started

```bash
# 1. Install dependencies
pnpm install

# 2. Ensure local Postgres is running
brew services start postgresql@16

# 3. Copy env file (if first time) and add your ANTHROPIC_API_KEY
cp packages/server/.env.example packages/server/.env

# 4. Run database migrations
pnpm --filter @memex/server db:migrate

# 5. (Optional) Seed the database
pnpm --filter @memex/server db:seed

# 6. Start the dev servers (or `make dev`)
pnpm dev:server    # API at http://localhost:8080
pnpm dev:admin     # React UI at http://localhost:5173 (strict port)
```

## Useful Commands

| Command | Purpose |
|---------|---------|
| `make dev` | Start server + React UI in parallel |
| `pnpm dev:server` | Start API in watch mode |
| `pnpm dev:admin` | Start React UI dev server |
| `pnpm build` | Build both server and React UI |
| `pnpm --filter @memex/server db:generate` | Generate migration from schema changes |
| `pnpm --filter @memex/server db:migrate` | Apply migrations |
| `pnpm --filter @memex/server db:seed` | Seed database |
| `rake db:nuke` | Drop and recreate local DB |
| `rake mcp:local` / `rake mcp:int` | Switch MCP config between local/prod |

## Testing

Tests use **Vitest** across seven tiers. All run server-side — the React UI has no test suite today.

| Command | Tier | Needs | What it runs |
|---------|------|-------|--------------|
| `make test` | All server | Local Postgres | Full local suite (everything except smoke) |
| `make test-unit` | Unit | — | Mocked services, pure functions, formatters, route handlers |
| `make test-integration` | Integration | Local Postgres | Service functions against real Postgres |
| `make test-api` | API / E2E | Local Postgres | Full HTTP request → SSE event propagation |
| `make test-security` | Security | Local Postgres | Auth, cross-memex isolation, injection, token hardening |
| `make test-perf` | Performance | Local Postgres | Concurrency + performance regressions |
| `make test-regression` | Regression | — | Architectural guards (URL shape, instructions cap, mutate coverage, build-asset copy) |
| `make smoke` | Health curl | Running server | One-line `/api/health` curl (respects `$SMOKE_URL`) |
| `make smoke-int` | Live smoke (int) | Deployed `int.memex.ai` | Pure-HTTP post-deploy suite — health, install scripts, SPA, MCP auth challenge, `get_information`, authed create→read→delete journey |
| `make smoke-prod` | Live smoke (prod) | Deployed `memex.ai` | Same shape, prod target |
| `make smoke-int-with-db` | Live smoke + DB | int + PAM + cloud-sql-proxy | Adds the telemetry tier: queries `mcp_tool_calls` to verify every MCP call landed a correctly-attributed row with full error envelope on failures |
| `make smoke-prod-with-db` | Live smoke + DB | prod + PAM + cloud-sql-proxy | Same shape, prod target |
| `make typecheck` | Types | — | TypeScript `--noEmit` on server + React UI |

### Naming conventions

| Pattern | Tier |
|---------|------|
| `*.test.ts` | Unit |
| `*.integration.test.ts` | Integration |
| `*.api.test.ts` | API / E2E |
| `src/__security__/*` | Security |
| `src/__perf__/*` | Performance |
| `src/__regression__/*.regression.test.ts` | Regression |
| `src/__smoke__/*.smoke.test.ts` | Smoke (live, post-deploy) |

### Running

```bash
# Prereq: local Postgres for anything beyond unit
brew services start postgresql@16

make test              # Everything except smoke (smoke needs a deployed env)
make test-unit         # Fast, no DB
make test-security     # Run the auth/tenant hardening suite
make smoke             # Quick health curl against localhost:8080
make smoke-int         # Live post-deploy suite against int.memex.ai
```

### Smoke testing policy (std-17 / spec-70)

Smoke is the safety net that lets us deploy with confidence. **Every change ships with smoke tests** — when you add a new surface, extend the suite to cover it. Smoke must be green post-deploy to int before promoting to prod.

- **Pure-HTTP tier** (`smoke-int` / `smoke-prod`) needs only a base URL and (optionally) `SMOKE_MCP_TOKEN` for the authed probes. Safe to run from any machine with network access.
- **DB tier** (`smoke-int-with-db` / `smoke-prod-with-db`) spins up `cloud-sql-proxy` and asserts side-effects in the database (today: `mcp_tool_calls` rows landing correctly for every MCP call). Requires the same PAM grant as `make deploy-server` and `SMOKE_DATABASE_URL` (the wrapper script sets it).
- **Skip-clean discipline**: every smoke describe block uses `describe.skipIf(...)` for credentials that may not be present, so a missing token / DB URL doesn't fail the suite — it just doesn't exercise that probe. CI fails on credential absence intentionally if a probe must run.

The first live smoke run caught a real `/mcp` SSE-framing bug that every local test passed. Local green ≠ deployed-and-working. Treat the smoke suite as load-bearing.

## Branches

Two long-lived branches, distinct roles. Full rule lives in **std-21** in Memex; the short version:

| Branch | Role | Deploys to | Licence (per `LICENSE.md`) |
|---|---|---|---|
| **`develop`** | Integration line — every feature, fix, refactor lands here first | `int.memex.ai` | Not licensed (internal development) |
| **`main`** | Production / release line — always reflects what's live | `memex.ai` | Sustainable Use License + EE carve-outs |

**Flow.** All work goes through `develop` first. `main` is **fast-forwarded** from `develop` at release time — it never accepts commits that haven't already lived on `develop` and passed int CI + smoke. There is no `main → develop` path; `main`'s history is always a subsequence of `develop`'s.

**Hotfixes** land on `develop` first, then propagate to `main` via the next fast-forward — never direct to `main`.

**Why this matters for contributors.** Feature branches target `develop` (see [`CONTRIBUTING.md`](CONTRIBUTING.md)). The licence carve-out in `LICENSE.md` is keyed to `main`, so code that's only on `develop` is not yet licensed — that's deliberate, and it's what makes the two-branch model commercially meaningful.

## Deployment

Memex ships as **two independently-deployable artefacts**: the Hono API + MCP endpoint + migrations (Cloud Run), and the React SPA (`packages/ui`, served from object storage behind a CDN). Most changes touch both, and they deploy in order — server first, then the SPA — or the browser keeps serving the old bundle against new endpoints.

```bash
make deploy            # both halves + post-deploy smoke (std-17)
make deploy-server     # API only (Cloud Run)
make deploy-admin      # SPA only (object storage + CDN)
```

> The official `memex.ai` / `int.memex.ai` instances are operated by Mindset on GCP, and the deploy scripts assume that environment (Cloud SQL, Secret Manager, and JIT credentials). The Mindset-internal runbook — project names, PAM entitlements, prerequisite CLIs — is not part of the public repo. Self-hosters should treat the `make deploy*` targets and `deploy.sh` / `packages/server/deploy.sh` as a reference and adapt them to their own infrastructure.

**Feature hiding (soft-launch control).** The server reads the per-environment `HIDDEN_FEATURES` env var (comma-separated feature slugs) at runtime to suppress UI elements — per-environment, all-or-nothing, fail-open (empty = nothing hidden). To hide/unhide a feature, edit `HIDDEN_FEATURES` in the target env's `scripts/deploy.<env>.env` and run `make deploy-server` (no admin-bundle rebuild needed). Full hide/unhide runbook: [`docs/feature-hiding.md`](docs/feature-hiding.md).

### Production URLs

| Service | URL |
|---------|-----|
| Marketing | https://www.memex.ai (apex `memex.ai/` 301s to `www.memex.ai/`) |
| App + tenant React UI | https://memex.ai/`<namespace>`/`<memex>` (int: https://int.memex.ai/`<namespace>`/`<memex>`) |
| API | https://memex.ai/api/... (int: https://int.memex.ai/api/...) |
| MCP endpoint | https://memex.ai/mcp (int: https://int.memex.ai/mcp) |
| Installer scripts | https://memex.ai/install.sh, https://memex.ai/install.ps1 |

### Google OAuth Setup (optional)

If you enable Google SSO, the OAuth client must have authorized JavaScript origins for every environment:
- `http://localhost:5173` (local dev, strict port)
- `https://int.memex.ai` (int env app + API)
- `https://memex.ai` (production app + API)

## Docker (OrbStack)

A `docker-compose.yml` is provided as an alternative for running Postgres in a container. Use [OrbStack](https://orbstack.dev/), not Docker Desktop:

```bash
docker compose up -d      # Start Postgres container
docker compose down       # Stop (data persists)
docker compose down -v    # Stop and wipe all data
```

## MCP Server

Memex exposes an MCP endpoint at `ALL /mcp` using Streamable HTTP transport, letting Claude interact with your Briefs and Standards directly.

Production URL: `https://memex.ai/mcp` (int env: `https://int.memex.ai/mcp`).

**Auth**: per-(user × device) `mxt_…` tokens, minted by the device-flow installer. Tokens never expire on their own; revoke via `/settings/tokens` in the React UI. One token works across all your memexes — memex context is resolved per tool call. Memex-scoped tools take a `memex` argument in `<namespace>/<memex>` form (e.g. `"mindset/website"`); the agent's first call in a multi-memex session is typically `list_memexes()`.

**For pointing an MCP client at a fully local Memex** (instead of int or prod), see [`docs/local-mcp-client.md`](docs/local-mcp-client.md). Covers Docker/Postgres setup, the `.env` footgun that blocks dev-fallback auth, minting an MCP token via the `mint-dev-token.ts` script, and configuring Claude Code / Claude Desktop to talk to `http://localhost:8080/mcp`.

### Quick install (recommended)

Opens your browser once to authorize, then writes both Claude config files:

```bash
# macOS / Linux
curl -fsSL https://memex.ai/install.sh | sh

# Windows (PowerShell)
irm https://memex.ai/install.ps1 | iex
```

Or directly: `npx -y memex-ai`. Reverse with `npx -y memex-ai uninstall`.

### Manual configuration

Mint a token at `https://memex.ai/settings/tokens`, then paste:

**Claude Code** — `~/.claude.json`:
```json
{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "https://memex.ai/mcp",
      "headers": { "Authorization": "Bearer mxt_…" }
    }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json`:
- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "memex": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://memex.ai/mcp", "--header", "Authorization:Bearer mxt_…"]
    }
  }
}
```

> Claude Desktop doesn't support remote HTTP MCP servers natively. The `mcp-remote` package bridges Streamable HTTP to stdio.

### Available MCP Tools

The live catalogue is `packages/server/src/agent/tool-specs.ts` (plus MCP-only `list_memexes` in `packages/server/src/mcp/tools.ts`). Every entity-acting tool takes a single canonical `ref` argument (`<ns>/<mx>/<doc-type>/<doc-handle>[/<child-type>/<child-handle>]`); memex-scoped tools take `memex` in `<namespace>/<memex>` form. Current groups:

| Group | Tools |
|---|---|
| Memex / docs | `list_memexes` (MCP-only), `list_docs` (memex-scoped), `create_doc` (memex-scoped), `get_doc` / `update_doc` (ref), `add_section` (ref of parent doc) / `update_section` (ref of section) |
| Specs | `publish_spec` (ref of spec), `assess_spec` (ref of spec) |
| Decisions | `create_decision` (ref of parent doc), `update_decision` / `resolve_decision` / `approve_candidate` / `reject_candidate` (ref of decision) |
| Tasks | `list_tasks` (ref of parent doc), `create_task` (ref of parent doc), `update_task` / `delete_task` (ref of task); blockers use `addBlockerRef` / `removeBlockerRef` fields on `update_task` |
| Comments | `add_comment` (ref of target), `list_comments` (ref of doc/section/decision/task — filter via `types` / `mode`), `update_comment` (ref of comment) |
| Memex-wide search | `search_memex` (memex-scoped; semantic + FTS across Briefs, Standards, free-form docs, and Decisions; filter via `kind`) |
| Slack handoff | `memex__send_slack_message` (requires the user to have connected Slack at `/settings/integrations`) |

Currently disabled (commented out in `tool-specs.ts`): standards-write verbs (`flag_drift`, `propose_standard_change`) and the codebase-intelligence group (`list_repos`, `get_repo`, `update_repo`, `list_symbols`, `get_symbol`, `get_file`, `code_search`). Old standards/decision/task names (`list_briefs`, `list_standards`, `update_doc_status`, `resolve_comment`, `reopen_decision`, `update_task_status`, `add_blocker`, etc.) have been removed — see `mcp/migration-map.ts`.

## Key API Endpoints

Tenancy-scoped routes are mounted twice — under `/api/<namespace>/<memex>/...` (canonical) and flat `/api/<resource>/...` (UUID-keyed lookups, std-5 exemption). See `CLAUDE.md` for the full surface.

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check |
| `POST /api/auth/signup` · `/login` · `/magic-link` · `/password-reset` · `/sso/google` · `/switch-account` | Auth flows (`switch-account` route name kept for client compat — semantically it now switches the current memex) |
| `GET /api/auth/me` · `GET /api/me/namespaces` | Current session + accessible memexes grouped by namespace |
| `POST /api/orgs` · `GET /api/orgs/check` · `PATCH /api/orgs/:id/slug` · `GET\|PATCH /api/orgs/current` | Org creation + slug management |
| `GET /api/consent/pending` · `POST /api/consent/decisions` | Domain-match auto-join consent (std-6) |
| `POST /api/invites` · `GET /api/invites/:token` · `POST /api/invites/:token/accept` | Team invites |
| `GET\|POST /api/<ns>/<mx>/docs` · `GET /api/<ns>/<mx>/docs/:id` | Briefs / Standards / Docs |
| `POST /api/<ns>/<mx>/docs/:docId/share` · `GET /api/share/:token` | Public share links |
| `POST /api/<ns>/<mx>/llm/chat` | Agent chat (SSE streaming, session required) |
| `GET /api/<ns>/<mx>/docs/events/:docId` | SSE stream — real-time changes for one doc |
| `GET /api/<ns>/<mx>/docs/events` | SSE stream — all changes in current memex |
| `POST /api/cli/auth/start` · `complete` · `poll/:reqId` | Device-flow installer |
| `GET\|DELETE /api/mcp/tokens` | MCP token management |
| `ALL /mcp` | MCP endpoint (Bearer mxt_ token) |
| `GET /install.sh` · `/install.ps1` | Bootstrap installer scripts |

## Logging

Every round-trip with the Anthropic API — including server-tool executions — is written to a per-session log at `packages/server/.logs/agent.log` (git-ignored). The previous session is preserved at `agent.log.prev`. Silence with `DEBUG_AGENT=0`.

```bash
tail -f packages/server/.logs/agent.log
```

See `CLAUDE.md` for the logging pattern to use when adding a new debug domain.

## Known Patterns and Gotchas

- **Tenant resolution**: `memexResolver` parses `/<namespace>/<memex>/` off the URL path and 404s unknown slug pairs. If local dev hits a 404 unexpectedly, check that your URL has both segments and that the slugs match what's in `namespaces.slug` / `memexes.slug`. The React UI router is path-based — `api/http.ts:tenantBase()` reads `window.location.pathname` directly (per t-23 of doc-15), so the browser URL is the source of truth.
- **Vite strict port**: `strictPort: true` in `vite.config.ts` forces port 5173. If it's in use, the dev server fails instead of picking another — intentional, because OAuth origins must match exactly.
- **Panel layout caching**: `react-resizable-panels` persists layout to `localStorage` by group ID. Bump the ID in `DocumentShell.tsx` (e.g., `memex-shell-v8` → `v9`) when changing default panel sizes to force a reset.
- **Tailwind dark mode**: `darkMode: 'class'` is configured but `dark:` variants are NOT reliably generated here. All theme-conditional styles use `isDark` ternaries from `useTheme()`.
- **SectionCard memoization**: `SectionCard` is wrapped in `React.memo` with a memoized `MemoizedMarkdown` inner component to avoid expensive re-renders (documents with many markdown sections).
- **UI tool resume**: When loading conversation history, dangling `tool_use` blocks (agent called a UI tool but user never responded) are stripped unless the current request is a `uiToolResult` resume. See `toAnthropicMessages()` in `routes/llm.ts`.
- **Decision reopen**: Reopening a resolved decision preserves the resolution text with a `Proposed: ` prefix rather than deleting it.
- **MCP tokens never expire**: `mxt_…` tokens are long-lived by design; revoke via `/settings/tokens` or `DELETE /api/mcp/tokens/:id`. Token is stored as SHA-256 hash; only the `prefix` is kept for UI display.
- **Postmark delivery in prod**: Postmark is approved (2026-05-05) and sends to any recipient domain. Verify SPF/DKIM/DMARC alignment for the sending domain. Use the console sender locally.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: trivial fixes go straight to a PR (sign-off required); non-trivial changes start with an issue or a Spec in Memex; EE contributions need a CLA. Memex itself is built using the Spec-driven workflow described in [`SDD.md`](SDD.md) — contributions are evaluated against the same Standards and Specs that govern internal work.

## License

Memex is [**fair-code**](https://faircode.io/). Fair-code is a software model — not a specific license — describing software that is:

1. **Generally free to use** and can be distributed by anybody.
2. **Source-available**, so anyone can read, audit, and learn from the code.
3. **Extensible by anyone** in public and private communities.
4. **Commercially restricted by the maintainers** so the project can be sustained as a business.

In Memex's case, that model is implemented as:

- The majority of the codebase is licensed under the [Sustainable Use License](LICENSE.md) — free for internal business use, non-commercial use, and personal use.
- Source code files containing `.ee.` in the filename or `.ee` in the dirname are covered by the [Memex Enterprise License](LICENSE_EE.md) and require a valid Memex Enterprise license for production use.
- Third-party components keep their original licenses.
- Content of branches other than `main` is not licensed.

### Where enterprise code lives

Enterprise (EE) code lives in **the same repository** as the open core — there is no private fork, no closed mirror, no submodule. Everything is visible to everyone; the **file path itself is the license marker**, and only production use of EE-marked files requires a valid Memex Enterprise license.

Two equivalent markers identify EE code (either qualifies — the convention is a file path test, not a build flag):

| Shape | Marker | Example |
|---|---|---|
| **Filename** | `.ee.` anywhere in the filename | `packages/server/src/services/sso.ee.ts` |
| **Dirname** | `.ee` as a literal directory name in the path | `packages/server/src/services/audit/.ee/recorder.ts` |
| **Dirname** | `.ee` as a literal directory name in the path | `packages/ui/src/components/.ee/RbacMatrix.tsx` |

**Rule of thumb:** single-file EE features (`sso.ee.ts`, `rbac.ee.ts`) use the filename marker; cluster EE features (multi-file audit module, full RBAC subsystem, EE-only admin UI surface) use a `.ee/` directory. The two are interchangeable — pick whichever keeps the change diff legible.

> **For contributors:** EE code is governed by [`LICENSE_EE.md`](LICENSE_EE.md), so PRs touching `.ee.` files require a CLA — see [`CONTRIBUTING.md`](CONTRIBUTING.md#ee-feature-ee--ee).

For enterprise licensing enquiries, contact [support@mindset.ai](mailto:support@mindset.ai).
