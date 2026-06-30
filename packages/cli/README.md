# memex-ai

[![npm](https://img.shields.io/npm/v/memex-ai.svg)](https://www.npmjs.com/package/memex-ai)

Zero-dependency CLI for installing the [Memex.AI](https://memex.ai) MCP server
into Claude Code and Claude Desktop.

```bash
npx -y memex-ai install
```

**One sign-in, both credentials.** A single device-flow authorization mints your
long-lived Personal Access Token (`mxt_...`) — planted as the MCP server entry —
**and** your one per-user spec-checkout key (`mxh_...`, stored at
`~/.memex/checkout.json`). No second sign-in, no per-memex keys, nothing pasted by
hand. The MCP entry is merged into:

- `~/.claude.json` (Claude Code / `claude` CLI)
- `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS Desktop)
- `%APPDATA%\Claude\claude_desktop_config.json` (Windows Desktop)

### Easiest path: let Claude Code drive it

Paste the **“Set up your coding agent”** prompt from your Memex into a fresh Claude
Code session — it runs the whole thing and explains each step:

```
npx -y memex-ai install                           # this CLI — MCP token + checkout key
claude plugin marketplace add mindset-ai/memex-ai
claude plugin install memex-checkout@memex         # the hooks-only checkout plugin
# …then reload the window (hooks load at session start)
```

The checkout plugin is **hooks-only** — it carries the spec-checkout hooks, not an
MCP server, so it never duplicates the MCP this CLI plants.

## Prefer OAuth?

For the cleanest setup, use Claude's native connector flow instead of this CLI:

- **Claude.ai web** → Settings → Connectors → **Add custom connector** → pick
  Memex from the directory.
- **Claude Code** → `claude mcp add memex --transport http https://memex.ai/mcp`
  (handles OAuth + PKCE natively, supports automatic refresh).
- **Claude Desktop** → the connector directory in-app, or `mcp-remote`.

OAuth is preferred because tokens auto-rotate and revoking takes effect on the
next call. **Use this `memex-ai` CLI when**:

- You're scripting Memex into a CI runner or non-interactive environment.
- You need a long-lived token (e.g. embedded in a config file).
- You're on a Claude client that doesn't support remote MCP OAuth yet.

## Usage

```bash
# Default: install (writes Claude configs)
npx -y memex-ai install

# Mint JUST the checkout key (when you already have the MCP) — one sign-in, no --memex
npx -y memex-ai checkout-setup

# Skip auto-opening the browser; print the URL instead
npx -y memex-ai install --no-browser

# Point at a custom Memex server (default: https://memex.ai)
npx -y memex-ai install --api-base https://int.memex.ai/api

# Remove Memex from all Claude configs
npx -y memex-ai uninstall
```

Run `npx memex-ai --help` for the full list.

## What gets written

The CLI merges this entry into each Claude config (it does NOT overwrite the
file; existing MCP servers stay):

```json
{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "https://memex.ai/mcp",
      "headers": { "Authorization": "Bearer mxt_..." }
    }
  }
}
```

## Revoking a token

The `uninstall` command removes the LOCAL config but does NOT revoke the
server-side token. To revoke:

1. Visit https://memex.ai/settings/tokens
2. Click **Revoke** next to the device label.

Or run `uninstall` followed by a server-side revoke.

## Releasing

`memex-ai` is published to the public npm registry. A change under `packages/cli`
reaches users ONLY when the package is published; merging to `develop` or `main` does
NOT ship it. There is no CI auto-publish, so every release is manual:

1. Bump `version` in `packages/cli/package.json`.
2. From `packages/cli`, run `npm publish`.

Publishing requires npm publish rights on the `memex-ai` package; ask a maintainer if
you don't have them.

## Source

Built and maintained at
[github.com/mindset-ai/memex-ai](https://github.com/mindset-ai/memex-ai)
under `packages/cli/`. Zero dependencies — Node 18+ built-ins only. PRs welcome.

## License

MIT
