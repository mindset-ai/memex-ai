// spec-336 — step 1 "Connect to the Memex MCP" (v2 originally had two stages; spec-421
// splits it: this component shows Stage 1 (MCP install) only.
// Stage 2 (create the spec) moved to CreateFirstSpecStep / step "create-first-spec".
//
// spec-482 dec-5 (ac-15): this step is verified via observed MCP TRAFFIC — the
// `mcpToolCalled` milestone (an `mcp.tool_called` usage_event ever recorded), NOT the
// `mcp.connected` handshake (`mcpConnected`). A handshake with no tool call isn't a
// meaningful connection. This mirrors the journey def (journeys/onboarding.ts) so the
// card's done-state and the rail orb tick on the same observed-traffic signal.
import { useEffect, useRef, useState } from 'react';
import { fetchJourneyStateApi } from '../../api/journey';
import { getCachedJourneyState } from '../../journeys/journeyStateCache';
import { Instructions, TOOLS, detectOs, type Os, type Tool } from './ConnectAgentStep';
import { EXPLORE_PROMPT, DOCS_HREF } from '../../utils/createSpecPrompts';

// spec-372 issue-9 — selected chips are WHITE-filled (bg-surface).
const chip = (selected: boolean) =>
  `rounded-lg border px-4 py-2 text-sm transition ${
    selected ? 'border-accent bg-surface font-semibold text-accent' : 'border-edge text-secondary hover:bg-card-hover'
  }`;

export function CreateSpecStep({
  preview = false,
  onComplete,
  onCtaClick,
}: {
  preview?: boolean;
  onComplete?: () => void;
  onCtaClick?: (target: string) => void;
} = {}) {
  // spec-372 issue-6 — OS is auto-detected; the manual "Your machine" selector is removed.
  const [os] = useState<Os>(detectOs);
  const [tool, setTool] = useState<Tool>('claude-code');
  // spec-421 issue-2 — assess "connected" BEFORE draw from the shared in-memory journey-state
  // (the read RootRedirect warmed at landing), so a revisiting user who has already connected
  // MCP sees the "Connected to the Memex MCP" card on the FIRST paint instead of the connect
  // card flipping to connected after an after-mount fetch (the in-Home flicker). Seeded refs
  // make the effect treat it as "already known, do not advance". Cold → false (today's path).
  const seededConnected = !preview && !!getCachedJourneyState()?.milestones?.mcpToolCalled;
  const [connected, setConnected] = useState(seededConnected);
  const [exploreCopied, setExploreCopied] = useState(false);
  const connectedRef = useRef(seededConnected);
  const initRef = useRef(seededConnected);

  // spec-372 change #13 — copy the doc-grounded evaluation prompt to the clipboard.
  const copyExplorePrompt = () => {
    try {
      void navigator.clipboard?.writeText(EXPLORE_PROMPT);
    } catch {
      /* clipboard unavailable — non-fatal */
    }
    onCtaClick?.('copy_explore_prompt');
    setExploreCopied(true);
    setTimeout(() => setExploreCopied(false), 1600);
  };

  // spec-421: step completes on the connect milestone (was hasSpec in spec-336).
  // spec-482 dec-5: that milestone is observed MCP traffic (mcpToolCalled), not the
  // mcp.connected handshake.
  useEffect(() => {
    if (preview) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (!alive) return;
        const isConnected = !!s.milestones?.mcpToolCalled;
        if (!initRef.current) {
          initRef.current = true;
          if (isConnected) {
            connectedRef.current = true;
            setConnected(true);
          }
          return;
        }
        if (isConnected) {
          setConnected(true);
          if (!connectedRef.current) {
            connectedRef.current = true;
            setTimeout(() => onComplete?.(), 1400);
          }
        }
      } catch {
        /* best-effort */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [preview, onComplete]);

  return (
    <div data-testid="journey-step-create-spec" className="animate-[panelIn_0.35s_ease] max-w-3xl">
      <h2 className="onboarding-heading mb-4">
        Connect to the Memex MCP
      </h2>
      {/* spec-372 t-13 — v3 subtitle weight is 500 (medium), not bold. */}
      <p className="mb-4 text-xl font-medium leading-snug text-primary">
        Get the full magic of Memex by connecting to the MCP and using it in your Agent
      </p>
      {/* spec-372 change #13 — "New to the MCP?" helper: docs link + Copy-a-prompt-for-your-agent. */}
      <p className="mb-7 flex flex-wrap items-center gap-x-2 gap-y-1 text-base text-secondary">
        <span>New to the MCP? Learn what it can do by</span>
        <a
          href={DOCS_HREF}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="mcp-docs-link"
          onClick={() => onCtaClick?.('docs_link')}
          className="font-semibold text-accent hover:underline"
        >
          reading the docs
        </a>
        <span>or</span>
        <button
          type="button"
          data-testid="copy-explore-prompt"
          onClick={copyExplorePrompt}
          className="inline-flex items-center gap-1.5 rounded-md bg-card-hover px-3 py-1.5 text-sm font-semibold text-secondary transition hover:text-primary"
        >
          {exploreCopied ? 'Copied!' : 'Copy a prompt for your agent'}
        </button>
      </p>

      {/* Connect to Memex MCP card — spec-372 t-13 / issue-19 done-state styling. */}
      <section
        data-testid="connect-stage"
        className={`rounded-2xl p-6 transition-all duration-300 ${
          connected
            ? 'border border-edge bg-surface'
            : 'border-[1.5px] border-accent bg-surface ring-[5px] ring-accent/10'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className={connected ? '' : 'mb-4'}>
            <div className="text-[28px] font-semibold leading-tight tracking-[-0.015em] text-heading">
              {connected ? 'Connected to the Memex MCP' : 'Connect to the Memex MCP'}
            </div>
            <div className="mt-1 text-base text-secondary">
              {connected
                ? "You're connected to the Memex MCP. Need to make changes? Manage it any time from the Integrations page under your profile menu."
                : 'Use the command below to install the MCP for your coding agent.'}
            </div>
          </div>
          {connected && (
            <span
              data-testid="create-spec-connected"
              className="mt-1 inline-flex flex-none items-center gap-1 rounded-full bg-status-success-bg px-2.5 py-1 text-xs font-semibold text-status-success-text"
            >
              <span aria-hidden>✓</span> Connected
            </span>
          )}
        </div>

        {!connected && (
          <>
            {/* spec-372 issue-6 — OS selector removed; `os` is auto-detected. */}
            <div className="mb-3">
              <span className="mb-2 block text-sm font-medium text-secondary">Your coding agent</span>
              <div className="flex flex-wrap gap-2">
                {TOOLS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`tool-${t.id}`}
                    onClick={() => {
                      setTool(t.id);
                      onCtaClick?.('connect_target');
                    }}
                    className={chip(t.id === tool)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div data-testid="connect-instructions">
              <Instructions tool={tool} os={os} onCopy={() => onCtaClick?.('copy_install')} />
            </div>
            {/* spec-421 issue-4 — make it clear the step doesn't tick on paste: it ticks the
                first time the agent actually connects (Frederic Zingg, via Slack). */}
            <div className="mt-4 flex items-start gap-2 text-sm text-muted" data-testid="connect-tick-hint">
              <span className="mt-0.5 h-2 w-2 flex-none animate-pulse rounded-full bg-accent" aria-hidden />
              <span>
                Run the command, then start your coding agent — this step ticks the first time your agent
                connects, not when you copy the command.
              </span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
