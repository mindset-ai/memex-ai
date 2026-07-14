// spec-482 (dec-7, dec-8; ac-5, ac-21, ac-23) — the post-creation handoff card.
//
// After a Spec is created, this persistent, sequenced card hands the user off to their
// coding agent in three beats: (1) CONNECT the Memex MCP server, (2) COPY this Spec's
// URL, (3) PASTE it into the agent and tell it to use the Memex MCP on this Spec. The
// copy in step 1 says "connect" and NEVER "install" (dec-7).
//
// This is a PURE / PRESENTATIONAL component: the connection signals arrive as props
// (`mcpConnected`, `thisSpecConnected`) so a later task can wire the real backend signal
// without touching this component. It reuses — never rebuilds — the connect primitives
// exported from ConnectAgentStep (`detectOs`, `TOOLS`, `Instructions`) so there is a
// single per-tool setup matrix (ac-23).
import { useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { detectOs, TOOLS, Instructions, type Tool } from './ConnectAgentStep';

export function PostCreationHandoffCard({
  specUrl,
  mcpConnected,
  thisSpecConnected,
  onCopySpecUrl,
}: {
  specUrl: string;
  mcpConnected: boolean;
  thisSpecConnected: boolean;
  // Fires after the Spec URL is copied — lets the parent record the handoff intent.
  onCopySpecUrl?: () => void;
}) {
  const [tool, setTool] = useState<Tool>('claude-code');
  // `detectOs` is reused for parity with ConnectAgentStep; the unified installer is
  // OS-agnostic today, so it's passed through but doesn't branch the command.
  const os = detectOs();

  // Lifecycle (ac-21): once this Spec is connected, the whole card collapses away.
  if (thisSpecConnected) {
    return (
      <div
        data-testid="handoff-collapsed"
        className="flex items-center gap-2 rounded-xl border border-edge bg-surface/60 px-4 py-2.5 text-sm text-muted"
      >
        <span
          aria-hidden
          className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-status-success-text text-xs text-white"
        >
          ✓
        </span>
        Your agent is working on this Spec.
      </div>
    );
  }

  // Lifecycle (ac-21): MCP is connected but this Spec hasn't been handed off yet — morph
  // to a compact confirmation that drops the connect step and points at paste.
  if (mcpConnected) {
    return (
      <article
        data-testid="handoff-connected"
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-6 shadow-xl backdrop-blur-xl sm:p-8"
      >
        <div className="mb-4 flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-status-success-text text-base text-white"
          >
            ✓
          </span>
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-status-success-text">
            Connected — now paste your Spec URL
          </span>
        </div>
        <p className="max-w-prose leading-relaxed text-secondary">
          Your agent is connected to the Memex MCP. Copy this Spec&apos;s URL, paste it into your
          coding agent, and tell it to use the Memex MCP on this Spec.
        </p>
        <div className="mt-5" data-testid="handoff-connected-url">
          <CodeBlock code={specUrl} onCopy={onCopySpecUrl} />
        </div>
      </article>
    );
  }

  // Full card (mcpConnected === false): all three sequenced steps.
  return (
    <article
      data-testid="post-creation-handoff-card"
      className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-6 shadow-xl backdrop-blur-xl sm:p-8"
    >
      <div className="mb-5 font-mono text-xs lowercase tracking-tight text-muted">
        // hand off to your coding agent
      </div>

      {/* Step 1 — connect (NEVER "install"): agent picker + reused per-tool setup. */}
      <section data-testid="handoff-step-connect">
        <div className="flex items-baseline gap-3">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-edge text-sm font-bold text-secondary">
            1
          </span>
          <h2 className="text-lg font-bold text-heading">Connect the Memex MCP server</h2>
        </div>
        <div className="mt-4 pl-10">
          <span className="mb-2 block text-sm font-medium text-secondary">Your coding agent</span>
          <div className="flex flex-wrap gap-2">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`handoff-tool-${t.id}`}
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
          <div className="mt-4" data-testid="handoff-connect-instructions">
            <Instructions tool={tool} os={os} />
          </div>
        </div>
      </section>

      {/* Step 2 — copy this Spec's URL (one-click copy affordance). */}
      <section data-testid="handoff-step-copy" className="mt-8">
        <div className="flex items-baseline gap-3">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-edge text-sm font-bold text-secondary">
            2
          </span>
          <h2 className="text-lg font-bold text-heading">Copy this Spec&apos;s URL</h2>
        </div>
        <div className="mt-4 pl-10" data-testid="handoff-spec-url">
          <CodeBlock code={specUrl} onCopy={onCopySpecUrl} />
        </div>
      </section>

      {/* Step 3 — paste + instruct. */}
      <section data-testid="handoff-step-paste" className="mt-8">
        <div className="flex items-baseline gap-3">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-edge text-sm font-bold text-secondary">
            3
          </span>
          <h2 className="text-lg font-bold text-heading">
            Paste it into your coding agent and tell it to use the Memex MCP on this Spec
          </h2>
        </div>
        <p className="mt-3 pl-10 max-w-prose leading-relaxed text-secondary">
          Drop the URL into your agent and ask it to use the Memex MCP on this Spec — it&apos;ll read
          the plan, decisions and tasks, then get to work.
        </p>
      </section>
    </article>
  );
}
