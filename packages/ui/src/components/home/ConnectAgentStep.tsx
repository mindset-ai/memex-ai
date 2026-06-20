// spec-305 dec-7 — the connect-agent step: the one real friction cliff, so it gets
// the richest card. Detect (and let the user change) their OS, pick their coding
// agent, and show the exact tailored MCP setup. When the connection lands, the card
// flips to a REWARD state — "your agent is now Memex-native, ask it anything" — which
// teaches get_information and proves the install in one beat. It auto-dismisses on the
// user's first tool call (or a manual Next). Reuses the portable installBase/mcpUrl
// derivation + the CodeBlock primitive (DRY with the Settings install section).
import { useEffect, useRef, useState } from 'react';
import { GlossaryTerm } from '../GlossaryTerm';
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

// The reward prompt — proves the agent is Memex-native and teaches get_information.
const ASK_PROMPT = `Using Memex (you're connected now), answer me:

"What is Memex, and what are its core principles? Use the get_information tool, then explain it simply — like I'm new."`;

function Instructions({ tool, os, onCopy }: { tool: Tool; os: Os; onCopy?: () => void }) {
  if (tool === 'claude-code' || tool === 'claude-desktop') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-secondary">
          Paste this into your terminal. It opens your browser once to authorize this
          device, then writes the Memex MCP entry into your {tool === 'claude-desktop' ? 'Claude Desktop' : 'Claude'} config.
        </p>
        <CodeBlock code={os === 'windows' ? psInstall : shInstall} onCopy={onCopy} />
        <p className="text-xs text-muted">One install, a long-lived token, no expiry.</p>
      </div>
    );
  }
  if (tool === 'cursor') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-secondary">
          Add to <code className="rounded-sm bg-card-hover px-1 py-0.5 text-xs">.cursor/mcp.json</code> (this project)
          or <code className="rounded-sm bg-card-hover px-1 py-0.5 text-xs">~/.cursor/mcp.json</code> (everywhere),
          reload Cursor, then complete the OAuth sign-in:
        </p>
        <CodeBlock code={cursorCfg} onCopy={onCopy} />
      </div>
    );
  }
  if (tool === 'vscode') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-secondary">
          Add to <code className="rounded-sm bg-card-hover px-1 py-0.5 text-xs">.vscode/mcp.json</code>, run{' '}
          <code className="rounded-sm bg-card-hover px-1 py-0.5 text-xs">MCP: List Servers → Start</code>, and complete
          the sign-in. VS Code / Copilot handle the OAuth callback automatically:
        </p>
        <CodeBlock code={vscodeCfg} onCopy={onCopy} />
      </div>
    );
  }
  if (tool === 'claude-web') {
    return (
      <div className="space-y-2">
        <ol className="list-inside list-decimal space-y-1 text-sm text-secondary">
          <li>
            Open <strong>Customize → Connectors</strong> (
            <a
              href="https://claude.ai/customize/connectors?modal=add-custom-connector"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary"
            >
              jump straight there
            </a>
            ).
          </li>
          <li>Click <strong>Add custom connector</strong>.</li>
          <li>Name it <strong>Memex</strong> and paste the URL below.</li>
          <li>Save, then complete the sign-in in the popup.</li>
        </ol>
        <CodeBlock code={mcpUrl} onCopy={onCopy} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-secondary">
        Add this URL in Windsurf or Zed&apos;s MCP config and sign in over OAuth — no token to paste:
      </p>
      <CodeBlock code={mcpUrl} onCopy={onCopy} />
    </div>
  );
}

export function ConnectAgentStep({
  preview = false,
  onComplete,
  onConnected,
  onCtaClick,
}: {
  preview?: boolean;
  onComplete?: () => void;
  // Called once when the connection is first detected — lets the parent "latch" so a
  // focus-refetch can't skip the reward state.
  onConnected?: () => void;
  // spec-324 — record the step's primary CTA (copy the setup command) as home_canvas.cta_clicked.
  onCtaClick?: (target: string) => void;
} = {}) {
  const [os, setOs] = useState<Os>(detectOs);
  const [tool, setTool] = useState<Tool>('claude-code');
  const [connected, setConnected] = useState(false);
  const doneRef = useRef(false);

  // Poll journey-state. On mcp.connected → flip to the reward state (and latch). On the
  // user's first tool call → auto-dismiss/advance. Operator preview is render-only.
  useEffect(() => {
    if (preview) return;
    let alive = true;
    let latched = false;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (!alive) return;
        if (s.milestones?.mcpToolCalled) {
          if (!doneRef.current) {
            doneRef.current = true;
            onComplete?.();
          }
          return;
        }
        if (s.milestones?.mcpConnected && !latched) {
          latched = true;
          setConnected(true);
          onConnected?.();
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
  }, [preview, onComplete, onConnected]);

  const osMatters = tool === 'claude-code' || tool === 'claude-desktop';

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid="journey-step-connect-agent"
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-12"
      >
        {connected ? (
          // Reward state — proves the agent is now Memex-native and teaches get_information.
          <div data-testid="connect-reward">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-status-success-text text-lg text-white">
                ✓
              </span>
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-status-success-text">
                Connected
              </span>
            </div>
            <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
              Your agent is now Memex-native.
            </h1>
            <p className="mt-4 max-w-prose leading-relaxed text-secondary">
              It can read your Memex and answer questions about it. Try it — ask your agent:
            </p>
            <div className="mt-5" data-testid="connect-reward-prompt">
              <CodeBlock code={ASK_PROMPT} />
            </div>
            <p className="mt-3 text-xs text-muted">
              Ask it and this moves on by itself the moment it calls a Memex tool — or just continue.
            </p>
            <div className="mt-7">
              <button
                type="button"
                data-testid="connect-next"
                onClick={() => onComplete?.()}
                className="inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(96deg,#8b5cf6,#6366f1)] px-5 py-3 text-sm font-bold text-white shadow-lg transition hover:brightness-110"
              >
                Next
                <span aria-hidden>→</span>
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-5 font-mono text-xs lowercase tracking-tight text-muted">
              // 01 · connect your agent
            </div>
            <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
              Bring your coding agent.
            </h1>
            <p className="mt-4 text-lg font-semibold text-primary">One connection, and your agent works straight from your plan.</p>
            <p className="mt-4 max-w-prose leading-relaxed text-secondary">
              Connect your agent over MCP and it can read your <GlossaryTerm term="spec">specs</GlossaryTerm>,{' '}
              <GlossaryTerm term="standard">standards</GlossaryTerm> and{' '}
              <GlossaryTerm term="decision">decisions</GlossaryTerm>, and report progress back. From here, your
              agent does the work while you watch it land.
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
              <Instructions tool={tool} os={os} onCopy={() => onCtaClick?.('copy_install')} />
            </div>

            <div className="mt-7 flex items-center gap-2 text-sm text-muted" data-testid="connect-waiting">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
              Waiting for your agent to connect — this lights up the moment it does.
            </div>
          </>
        )}
      </article>
    </div>
  );
}
