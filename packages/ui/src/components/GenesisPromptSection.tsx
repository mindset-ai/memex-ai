// spec-201 dec-6: the "Genesis prompt" connect section. A sibling of
// CliInstallSection on the Integrations page. Renders a single copy-pasteable
// prompt the user drops into a fresh Claude Code or Cursor session; the agent
// then registers the Memex MCP server in its own config and writes a durable
// Memex-use clause into its project memory.
//
// Static copy only (ac-21): nothing here runs or verifies the bootstrap — the
// pasted agent does the work. The embedded MCP URL is environment-derived
// (ac-18) via utils/mcpUrl.ts, the same source CliInstallSection uses.

import { useState } from 'react';
import { CodeBlock, InlineCode } from './CodeBlock';
import { mcpUrl } from '../utils/mcpUrl';
import { buildClaudeCodePrompt, buildCursorPrompt } from '../utils/genesisPrompt';

type Client = 'claude-code' | 'cursor';

const CLIENTS: { id: Client; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
];

export function GenesisPromptSection() {
  const [client, setClient] = useState<Client>('claude-code');

  const prompt =
    client === 'claude-code' ? buildClaudeCodePrompt(mcpUrl) : buildCursorPrompt(mcpUrl);

  const memoryFile =
    client === 'claude-code' ? 'CLAUDE.md' : '.cursor/rules/memex.mdc';

  return (
    <section id="genesis-prompt" aria-labelledby="genesis-prompt-heading">
      <h2 id="genesis-prompt-heading" className="text-xl font-semibold mb-2 text-heading">
        Set up with one prompt
      </h2>
      <p className="mb-6 text-secondary">
        Prefer to let your agent wire itself up? Paste this into a fresh{' '}
        <strong>Claude Code</strong> or <strong>Cursor</strong> session. It registers the
        Memex MCP server and writes a short "how to use Memex" note into your{' '}
        <InlineCode>{memoryFile}</InlineCode> so the agent reaches for Memex every session
        — not just this one.
      </p>

      <div role="tablist" aria-label="Choose your agent" className="flex gap-2 mb-4">
        {CLIENTS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={client === id}
            onClick={() => setClient(id)}
            className={
              client === id
                ? 'px-3 py-1.5 text-sm font-medium rounded transition-colors bg-btn-primary text-on-primary'
                : 'px-3 py-1.5 text-sm font-medium rounded transition-colors bg-btn-secondary hover:bg-btn-secondary-hover text-secondary'
            }
          >
            {label}
          </button>
        ))}
      </div>

      <CodeBlock code={prompt} />

      <p className="text-xs mt-3 text-muted">
        This is just text to copy — Memex doesn't run anything on your machine. Your agent
        completes the browser sign-in itself when it adds the server.
      </p>
    </section>
  );
}
