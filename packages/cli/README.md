# memex-ai

[![npm](https://img.shields.io/npm/v/memex-ai.svg)](https://www.npmjs.com/package/memex-ai)

Zero-dependency CLI for installing the [Memex.AI](https://memex.ai) MCP server
into Claude Code and Claude Desktop.

```bash
npx memex-ai
```

That's it. The CLI walks you through a device-flow authorization, gets a
long-lived Personal Access Token (`mxt_...`), and merges the MCP server entry
into:

- `~/.claude.json` (Claude Code / `claude` CLI)
- `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS Desktop)
- `%APPDATA%\Claude\claude_desktop_config.json` (Windows Desktop)

Restart Claude and Memex tools are available in any conversation.

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
npx memex-ai

# Custom device label (default: hostname)
npx memex-ai --label "Linux laptop"

# Skip auto-opening the browser; print the URL instead
npx memex-ai --no-browser

# Point at a custom Memex server (default: https://memex.ai)
npx memex-ai --api-base https://int.memex.ai/api

# Remove Memex from all Claude configs
npx memex-ai uninstall
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

## Source

Built and maintained at
[github.com/mindset-ai/memex-ai](https://github.com/mindset-ai/memex-ai)
under `packages/cli/`. Zero dependencies — Node 18+ built-ins only. PRs welcome.

## License

MIT
