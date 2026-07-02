// spec-201 dec-6: the "Genesis prompt" — a copy-pasteable first prompt a user
// drops into a fresh coding-agent session so the AGENT bootstraps itself: it
// registers the Memex MCP server in its own config AND writes a durable "how to
// use Memex" clause into the project's agent memory, so the agent reaches for
// Memex on every future session. spec-452 adds Copilot (VS Code agent mode) as a
// third coder; all three builders share the same two jobs and the same clause.
//
// Pure string builders parameterised by the environment-derived MCP URL
// (utils/mcpUrl.ts) so the prompt is correct per environment and the content is
// unit-testable without rendering (ac-18/ac-19/ac-20; spec-452 ac-11..17).
//
// This file is on the scaffold-drift-guard allowlist (std-15): it is human-pasted
// clipboard text for the USER's own agent, not Mindset-agent prompt prose, so the
// prose lives here rather than in scaffold-data.ts.

// The durable usage clause. This is the part nothing else does — the installer
// and the Connectors Directory cover MCP registration, but only this teaches the
// agent how to work with Memex on every subsequent session.
export const MEMEX_USAGE_GUIDANCE = `## Using Memex

Memex hosts our Specs — living plans that capture a piece of work's purpose, its decisions, and its tasks. Whenever you do spec work:

- Call \`list_memexes\` and pick the right workspace — never assume the default.
- Orient with \`list_docs\` / \`get_doc\` before mutating anything.
- Resolve decisions before creating tasks; tasks exist only in the \`build\` phase.
- Reference items by handle: spec-N, dec-N, t-N, ac-N.`;

export function buildClaudeCodePrompt(mcpUrl: string): string {
  // spec-430 dec-2/dec-4 (supersedes spec-201's `claude mcp add` for Claude Code):
  // the unified `npx memex-ai install` plants the MCP token AND mints the single
  // per-user checkout key off ONE browser sign-in; the hooks-only spec-checkout
  // plugin is then added with `claude plugin …`. This flow is CLAUDE-CODE-ONLY — the
  // plugin does not work in Cursor (buildCursorPrompt stays MCP-only, no plugin).
  const apiBase = mcpUrl.replace(/\/mcp$/, '');
  const apiBaseFlag = apiBase === 'https://memex.ai' ? '' : ` --api-base ${apiBase}`;
  return `Set up Memex in this repo for me, and explain each step as you run it:

1. Install the Memex MCP server + your checkout key (ONE browser sign-in):
   npx -y memex-ai install${apiBaseFlag}

2. Install the spec-checkout plugin (the in-flow edit hooks):
   claude plugin marketplace add mindset-ai/memex-ai
   claude plugin install memex-checkout@memex

3. Then tell me to reload the window — the hooks load at session start.

4. Add the following to this project's CLAUDE.md (create the file if it doesn't
   exist; if a "Using Memex" section is already there, leave it):

${MEMEX_USAGE_GUIDANCE}

If a step is already done, say so and skip it; never ask me to paste a key by hand. Then confirm \`list_memexes\` works.`;
}

export function buildCursorPrompt(mcpUrl: string): string {
  return `Set up Memex in this project:

1. Add the Memex MCP server to Cursor's MCP config — \`.cursor/mcp.json\` in this
   project (or \`~/.cursor/mcp.json\` for every project):
   {
     "mcpServers": {
       "memex": { "url": "${mcpUrl}" }
     }
   }
   Reload Cursor and complete the browser sign-in if you're prompted to authorize.

2. Create \`.cursor/rules/memex.mdc\` with this content:
   ---
   description: How to use Memex for spec-driven work
   alwaysApply: true
   ---
${MEMEX_USAGE_GUIDANCE}

Then confirm both steps are done and that the Memex tools are available.`;
}

// spec-452 dec-3: Copilot targets VS Code AGENT MODE only. The prompt registers the
// server in `.vscode/mcp.json` (the `servers` / `type:"http"` / `url` shape, OAuth on
// connect) and writes the durable clause into `.github/copilot-instructions.md` (dec-2) —
// the repo-wide instructions file Copilot reads every session, the CLAUDE.md analogue.
// MCP-only over OAuth: NO checkout plugin (Claude-Code-only), and the Copilot cloud
// coding agent is deliberately out of scope (it can't do OAuth remote MCP), so this
// prompt never mentions a personal access token or a repo-Settings MCP surface.
export function buildCopilotPrompt(mcpUrl: string): string {
  return `Set up Memex in this project for GitHub Copilot (VS Code agent mode):

1. Add the Memex MCP server to VS Code's MCP config — \`.vscode/mcp.json\` in this
   project (create it if it doesn't exist):
   {
     "servers": {
       "memex": { "type": "http", "url": "${mcpUrl}" }
     }
   }
   Reload VS Code, then run "MCP: List Servers" → Start and complete the browser
   sign-in when Copilot prompts you to authorize.

2. Create \`.github/copilot-instructions.md\` (append if it already exists) with this content:
${MEMEX_USAGE_GUIDANCE}

Then confirm both steps are done and that the Memex tools are available in Copilot's agent mode.`;
}
