# Connect a local MCP client to local Memex

This document covers the end-to-end setup for running Memex locally and pointing an MCP client (Claude Code, Claude Desktop, or any compliant agent) at the local instance instead of `memex.ai` or `int.memex.ai`. Use this when you want to develop against Memex itself without touching int or prod data, or when you're building a feature that requires schema or service changes.

## What you'll end up with

- Postgres 16 (with pgvector) running in a container, isolated from anything else on your machine
- The Memex server on `http://localhost:8080` and the React UI on `http://localhost:5173`
- A `dev@memex.ai` user auto-created via the session middleware's dev fallback, with a personal Memex at `dev/personal`
- A long-lived `mxt_` MCP token for that user
- Your MCP client (Claude Code, Claude Desktop) connected to `http://localhost:8080/mcp` using that token, with the local `mcp__memex-local__*` tools available alongside any prod/int connections you already have

## Prerequisites

- Node.js 22+ (24 also works)
- pnpm 10
- Docker (Docker Desktop or OrbStack)

## Step 1: Start Postgres in a container

The repo's `docker-compose.yml` defines a `pgvector/pgvector:pg16` container named `memex-postgres`. Data persists in a named volume so the database survives `docker compose down`.

```bash
docker compose up -d
# wait a few seconds for Postgres to be ready
docker compose exec postgres pg_isready -U postgres
```

If you've previously stood up a stale local instance and the migration tracking table is missing (you'll see `relation "documents" already exists` errors during migrate), reset cleanly:

```bash
docker compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS memex;"
docker compose exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE memex;"
```

## Step 2: Set up the server `.env`

```bash
cp packages/server/.env.example packages/server/.env
```

**Important: the `.env.example` footgun.** The example file ships with `GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com` and `ANTHROPIC_API_KEY=your-anthropic-api-key`. These non-empty placeholder values satisfy `process.env.GOOGLE_CLIENT_ID`, which causes `isDevMode()` in `packages/server/src/middleware/session.ts` to return `false`. The dev-fallback user never gets created, and every REST and MCP call returns `{"error": "Missing Authorization header"}` without telling you why.

For a pure local-dev setup with no Google SSO, strip those lines:

```bash
sed -i '' '/^GOOGLE_CLIENT_ID=your-google-oauth/d' packages/server/.env
sed -i '' '/^ANTHROPIC_API_KEY=your-anthropic-api-key/d' packages/server/.env
```

Your `.env` should now contain only `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/memex` plus the file's comment header. With `GOOGLE_CLIENT_ID` unset, the session middleware will auto-authenticate every request as `dev@memex.ai` and auto-create that user on first contact.

If you want the AI agent to actually work locally (not just the MCP surface), add a real `ANTHROPIC_API_KEY` instead of removing the line. The agent endpoint will error without one but the rest of the server runs fine.

## Step 3: Install dependencies and build the shared package

```bash
pnpm install
pnpm --filter @memex/shared build
```

The `@memex/shared` build is required because both `packages/server` and `packages/ui` import from it as a workspace dependency; the TypeScript needs to be compiled before either consumer can resolve it.

## Step 4: Run all migrations

```bash
pnpm --filter @memex/server db:migrate
```

This applies all Drizzle migrations plus any hand-written ones in `packages/server/scripts/apply-hand-migrations.sh`. On a clean DB you should see 60+ migrations apply cleanly.

## Step 5: Start the server and React UI

**Run this in a standalone terminal (Terminal.app or iTerm), NOT in VS Code's integrated terminal and NOT via a Claude Code background task.** When VS Code reloads its window (or Claude Code itself restarts), any process living under either of those gets killed silently, and the server is gone. The MCP client then reports the `memex-local` server as disconnected without a clear cause. A standalone terminal is independent of VS Code's lifecycle and survives every reload.

Both server and React UI:

```bash
cd ~/Documents/GitHub/memex-app
make dev
```

Server-only (skips the React UI; faster, less log noise, sufficient for MCP-only work):

```bash
cd ~/Documents/GitHub/memex-app
pnpm dev:server
```

Either command produces `Server listening on http://localhost:8080`. Auto-reloads on file changes via `tsx watch`. Ctrl-C to stop.

Verify:

```bash
curl http://localhost:8080/api/health
# {"status":"ok","timestamp":"..."}
```

If you also ran `make dev`:

```bash
curl -o /dev/null -w "%{http_code}\n" http://localhost:5173/
# 200
```

## Step 6: Create the dev user

The dev-fallback user is created lazily on first request to a session-middleware-protected endpoint. Hit one to force the creation:

```bash
curl http://localhost:8080/api/auth/me
```

Response includes the new user's id, their personal namespace (`dev`), and their personal Memex (`dev/personal`).

## Step 7: Mint an MCP token

The `/mcp` endpoint requires a Bearer token. The UI-driven token-mint flow at `/settings/tokens` requires you to have signed in via SSO, which the dev user can't do. For local dev, mint the token programmatically using the included script:

```bash
pnpm tsx packages/server/scripts/mint-dev-token.ts
```

Output includes a line `raw_token: mxt_...`. Copy this token. It is only displayed once; the database stores only the hash. If you lose it, re-run the script to mint a new one (or revoke the old one in the UI).

Verify the token works against `/mcp`:

```bash
TOKEN="mxt_..."  # paste your token
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

You should get back an `event: message` with the full MCP `initialize` response, including the Memex agent instructions string. If you get HTTP 401, the token is wrong or the server isn't running.

## Step 8: Point your MCP client at local

### Claude Code

Add to `~/.claude.json` under the `mcpServers` block. Keep any existing entries (e.g. `memex-int`) alongside; you can run both simultaneously:

```json
"memex-local": {
  "type": "http",
  "url": "http://localhost:8080/mcp",
  "headers": {
    "Authorization": "Bearer mxt_..."
  }
}
```

Or via the CLI:

```bash
claude mcp add --scope user memex-local --transport http http://localhost:8080/mcp --header "Authorization:Bearer mxt_..."
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Claude Desktop doesn't natively support remote HTTP MCP servers, so route through `mcp-remote`:

```json
"memex-local": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://localhost:8080/mcp", "--header", "Authorization:Bearer mxt_..."]
}
```

### Generic MCP clients

Same shape as above: `http://localhost:8080/mcp`, Bearer token via the `Authorization` header.

## Step 9: Restart the client and verify

MCP clients read their config at startup. Restart the client fully (quit and reopen, not just reload):

- **Claude Code (terminal)**: exit and re-run `claude`.
- **Claude Code (VS Code extension)**: a full window reload usually picks up the change; if not, restart VS Code.
- **Claude Desktop**: quit and reopen the app.

Once restarted, you should see `mcp__memex-local__*` tools available. Test with a `list_memexes` call. You should see your `dev/personal` workspace.

## Optional: tear it all down

When you're done with the local setup:

```bash
# stop the dev server
pkill -f "tsx watch src/index.ts"
pkill -f vite

# stop and remove the Postgres container, keeping the volume
docker compose down

# OR stop and wipe the data entirely
docker compose down -v
```

Your MCP client entry in `~/.claude.json` (or the equivalent) can stay; it'll just fail to connect when the server isn't up. Remove it with `claude mcp remove memex-local --scope user` if you want it gone.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `{"error":"Missing Authorization header"}` on REST calls | `GOOGLE_CLIENT_ID` is set in `.env` (likely from copying `.env.example` unchanged), so dev fallback is disabled | Strip `GOOGLE_CLIENT_ID` from `.env`, restart server |
| `relation "documents" already exists` during migrate | Stale container from a previous setup with a partial schema | Drop and recreate the `memex` database, then re-migrate |
| `Cannot find package '@memex/shared'` on server start | The shared package hasn't been built | `pnpm --filter @memex/shared build` |
| Server doesn't restart after `.env` change | `make dev` watches source files but not `.env` | Kill and re-run `make dev` |
| `Invalid or revoked MCP token` from `/mcp` | Token typo, or you re-ran `mint-dev-token.ts` and are using a stale one | Mint a fresh token with the script, update your client config |
| MCP tools don't appear after restart | Client didn't fully restart, or the JSON config has a syntax error | Verify with `claude mcp list` (Claude Code) or check the client's MCP-server panel |

## How local differs from int and prod

- **Authentication**: local uses the dev fallback (no real auth). Int and prod require Google SSO or OAuth.
- **OAuth**: local doesn't mount the OAuth routes by default (`OAUTH_ENABLED` unset). Int and prod do, for the Anthropic Connectors Directory integration.
- **Data**: local is whatever you've created in your local DB. Int and prod hold real team workspaces.
- **Email**: local uses the `ConsoleEmailSender` by default (emails print to stdout). Int and prod use Postmark.
- **MCP token format**: identical (`mxt_...`). The token issued by `mint-dev-token.ts` works the same shape as one issued by the prod UI.
