// spec-305 dec-7 — the connect-agent step: the one real friction cliff, so it gets
// the richest card. Detect (and let the user change) their OS, pick their coding
// agent, and show the exact tailored MCP setup. A live green-tick lights up the
// instant we detect the connection — no manual "I'm done". Reuses the portable
// installBase/mcpUrl derivation and the CodeBlock primitive (DRY with the Settings
// install section + the docs page).
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { installBase, mcpUrl } from '../../utils/mcpUrl';
import { fetchJourneyStateApi } from '../../api/journey';

type Os = 'mac' | 'windows' | 'linux';
type Tool = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'claude-web' | 'windsurf-zed';

function detectOs(): Os {
  if (typeof navigator === 'undefined') return 'mac';
  const s = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (s.includes('win')) return 'windows';
  if (s.includes('linux') && !s.includes('android')) return 'linux';
  return 'mac';
}

const OS_LABEL: Record<Os, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };
const TOOLS: ReadonlyArray<{ id: Tool; label: string }> = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code / Copilot' },
  { id: 'claude-web', label: 'claude.ai (web)' },
  { id: 'windsurf-zed', label: 'Windsurf / Zed' },
];

const shInstall = `curl -fsSL ${installBase}/install.sh | sh`;
const psInstall = `irm ${installBase}/install.ps1 | iex`;
const cursorCfg = `{\n  "mcpServers": {\n    "memex": {\n      "url": "${mcpUrl}"\n    }\n  }\n}`;
const vscodeCfg = `{\n  "servers": {\n    "memex": {\n      "type": "http",\n      "url": "${mcpUrl}"\n    }\n  }\n}`;

function Instructions({ tool, os }: { tool: Tool; os: Os }) {
  if (tool === 'claude-code' || tool === 'claude-desktop') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-secondary">
          Paste this into your terminal. It opens your browser once to authorize this
          device, then writes the Memex MCP entry into your {tool === 'claude-desktop' ? 'Claude Desktop' : 'Claude'} config.
        </p>
        <CodeBlock code={os === 'windows' ? psInstall : shInstall} />
        <p className="text-xs text-muted">One install, a long-lived token, no expiry.</p>
      </div>
    );
  }
  if (tool === 'cursor') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-secondary">
          Add to <code className="rounded bg-card-hover px-1 py-0.5 text-xs">.cursor/mcp.json</code> (this project)
          or <code className="rounded bg-card-hover px-1 py-0.5 text-xs">~/.cursor/mcp.json</code> (everywhere),
          reload Cursor, then complete the OAuth sign-in:
        </p>
        <CodeBlock code={cursorCfg} />
      </div>
    );
  }
  if (tool === 'vscode') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-secondary">
          Add to <code className="rounded bg-card-hover px-1 py-0.5 text-xs">.vscode/mcp.json</code>, run{' '}
          <code className="rounded bg-card-hover px-1 py-0.5 text-xs">MCP: List Servers → Start</code>, and complete
          the sign-in. VS Code / Copilot handle the OAuth callback automatically:
        </p>
        <CodeBlock code={vscodeCfg} />
      </div>
    );
  }
  if (tool === 'claude-web') {
    return (
      <div className="space-y-2">
        <ol className="list-inside list-decimal space-y-1 text-sm text-secondary">
          <li>Open <strong>Settings → Connectors</strong>.</li>
          <li>Click <strong>Add custom connector</strong>.</li>
          <li>Name it <strong>Memex</strong> and paste the URL below.</li>
          <li>Save, then complete the sign-in in the popup.</li>
        </ol>
        <CodeBlock code={mcpUrl} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-secondary">
        Add this URL in Windsurf or Zed&apos;s MCP config and sign in over OAuth — no token to paste:
      </p>
      <CodeBlock code={mcpUrl} />
    </div>
  );
}

export function ConnectAgentStep({
  preview = false,
  onComplete,
}: {
  preview?: boolean;
  onComplete?: () => void;
} = {}) {
  const [os, setOs] = useState<Os>(detectOs);
  const [tool, setTool] = useState<Tool>('claude-code');
  const [connected, setConnected] = useState(false);
  const doneRef = useRef(false);

  // Live green-tick: poll journey-state for mcp.connected while on this step. The MCP
  // handshake records the milestone server-side; we light up the instant we see it,
  // then advance. Operator preview is render-only — no polling, no advance.
  useEffect(() => {
    if (preview) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (alive && s.milestones?.mcpConnected) {
          setConnected(true);
          if (!doneRef.current) {
            doneRef.current = true;
            setTimeout(() => onComplete?.(), 1400);
          }
        }
      } catch {
        /* polling is best-effort */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [preview, onComplete]);

  const osMatters = tool === 'claude-code' || tool === 'claude-desktop';

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid="journey-step-connect-agent"
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-12"
      >
        <div className="mb-5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
          Memex · First, the big one
        </div>
        <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
          Bring your coding agent.
        </h1>
        <p className="mt-4 text-lg font-semibold text-primary">This is the one that unlocks everything else.</p>
        <p className="mt-4 max-w-prose leading-relaxed text-secondary">
          Connect your agent over MCP and it can read your specs, standards and decisions, and report progress
          back. From here, your agent does the work while you watch it land.
        </p>

        {osMatters && (
          <div className="mt-7">
            <span className="mb-2 block text-sm font-medium text-secondary">Your machine</span>
            <div className="flex flex-wrap gap-2">
              {(['mac', 'windows', 'linux'] as Os[]).map((o) => (
                <button
                  key={o}
                  type="button"
                  data-testid={`os-${o}`}
                  onClick={() => setOs(o)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                    o === os
                      ? 'border-accent bg-accent/10 font-medium text-accent'
                      : 'border-edge text-secondary hover:bg-card-hover'
                  }`}
                >
                  {OS_LABEL[o]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6">
          <span className="mb-2 block text-sm font-medium text-secondary">Your coding agent</span>
          <div className="flex flex-wrap gap-2">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`tool-${t.id}`}
                onClick={() => setTool(t.id)}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  t.id === tool
                    ? 'border-accent bg-accent/10 font-medium text-accent'
                    : 'border-edge text-secondary hover:bg-card-hover'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6" data-testid="connect-instructions">
          <Instructions tool={tool} os={os} />
        </div>

        <div className="mt-7" data-testid="connect-status">
          {connected ? (
            <div
              data-testid="connect-connected"
              className="flex items-center gap-3 rounded-xl border border-status-success-border bg-status-success-bg px-4 py-3 text-status-success-text"
            >
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-status-success-text text-base text-white">
                ✓
              </span>
              <span className="font-semibold">Your agent is connected. Taking you on…</span>
            </div>
          ) : (
            <div data-testid="connect-waiting" className="flex items-center gap-2 text-sm text-muted">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
              Waiting for your agent to connect — this lights up the moment it does.
            </div>
          )}
        </div>
      </article>
    </div>
  );
}
