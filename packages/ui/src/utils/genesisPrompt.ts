// spec-201 dec-6: the "Genesis prompt" — a copy-pasteable first prompt a user
// drops into a fresh Claude Code or Cursor session so the AGENT bootstraps
// itself: it registers the Memex MCP server in its own config AND writes a
// durable "how to use Memex" clause into the project's agent memory, so the
// agent reaches for Memex on every future session.
//
// Pure string builders parameterised by the environment-derived MCP URL
// (utils/mcpUrl.ts) so the prompt is correct per environment and the content is
// unit-testable without rendering (ac-18/ac-19/ac-20).

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
  return `Set up Memex in this repo:

1. Register the Memex MCP server:
   claude mcp add --transport http memex ${mcpUrl}
   Then complete the browser sign-in if you're prompted to authorize.

2. Add the following to this project's CLAUDE.md (create the file if it doesn't
   exist; if a "Using Memex" section is already there, leave it):

${MEMEX_USAGE_GUIDANCE}

Then confirm both steps are done and that calling \`list_memexes\` works.`;
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
