// spec-336 — step 1 "Create your spec" (v2). Flat, full-width, two numbered stages:
// Stage 1 connects the coding agent to Memex over MCP (reusing the built per-tool/OS
// installer — dec-4, never the flat INT one-liner), Stage 2 creates the first spec with
// that agent or in the app. The STEP advances on the hasSpec milestone; Stage 1's
// connection shows inline (a green tick on mcpConnected) but is not itself a gate.
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { StepDoneBadge } from './StepDoneBadge';
import { fetchJourneyStateApi } from '../../api/journey';
import { Instructions, TOOLS, detectOs, type Os, type Tool } from './ConnectAgentStep';
// spec-372 — clipboard prompt prose lives in a dedicated util module (std-23 / b-68
// prose-location guard), not inline here. These are human-pasted prompts for the user's
// own coding agent, not Mindset-agent prose, so they sit alongside genesisPrompt.ts.
import {
  SAMPLE_PROMPT,
  PRD_PROMPT,
  APP_SAMPLE_PROMPT,
  APP_PRD_PROMPT,
  EXPLORE_PROMPT,
  DOCS_HREF,
} from '../../utils/createSpecPrompts';

type Source = 'prd' | 'sample';
type Method = 'agent' | 'app';

// spec-372 issue-9 — selected chips are WHITE-filled (bg-surface), keeping the accent
// border + accent text as the selection cue (consistent with the white method toggle).
const chip = (selected: boolean) =>
  `rounded-lg border px-4 py-2 text-sm transition ${
    selected ? 'border-accent bg-surface font-semibold text-accent' : 'border-edge text-secondary hover:bg-card-hover'
  }`;

// spec-372 t-13 — v3 stage heading: 28px / 600, no number prefix (the v2 mono "1/2" is gone).
function StageHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-4">
      <div className="text-[28px] font-semibold leading-tight tracking-[-0.015em] text-heading">{title}</div>
      <div className="mt-1 text-base text-secondary">{sub}</div>
    </div>
  );
}

export function CreateSpecStep({
  preview = false,
  onComplete,
  onCreateInApp,
  onCtaClick,
}: {
  preview?: boolean;
  onComplete?: () => void;
  onCreateInApp?: () => void;
  onCtaClick?: (target: string) => void;
} = {}) {
  // spec-372 issue-6 — OS is auto-detected; the manual "Your machine" selector is removed.
  const [os] = useState<Os>(detectOs);
  const [tool, setTool] = useState<Tool>('claude-code');
  const [method, setMethod] = useState<Method>('agent');
  const [source, setSource] = useState<Source>('sample');
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState(false);
  const [exploreCopied, setExploreCopied] = useState(false);
  const doneRef = useRef(false);
  const initRef = useRef(false);

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

  useEffect(() => {
    if (preview) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (!alive) return;
        if (s.milestones?.mcpConnected) setConnected(true);
        const hasSpec = !!s.milestones?.hasSpec;
        // First read after this step opens. If the spec already exists the user is
        // REVISITING a completed step — show it as done but do NOT advance them off it
        // (spec-336 dec-6: viewing never bumps you forward). Only a hasSpec transition
        // observed while the step is open advances the canvas.
        if (!initRef.current) {
          initRef.current = true;
          if (hasSpec) {
            doneRef.current = true;
            setDone(true);
          }
          return;
        }
        if (hasSpec) {
          setDone(true);
          if (!doneRef.current) {
            doneRef.current = true;
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
        Build exactly what you decided
      </h2>
      {/* spec-372 t-13 — v3 subtitle weight is 500 (medium), not bold. */}
      <p className="mb-4 text-xl font-medium leading-snug text-primary">
        Get the full magic of Memex by connecting to the MCP and using it in
        your coding agent
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

      {/* Stage 1 — Connect to Memex MCP (reuses the real per-tool/OS installer).
          spec-372 t-13 — v3 highlights this card: 1.5px accent border + a soft accent glow ring. */}
      <section
        data-testid="connect-stage"
        className="mb-5 rounded-2xl border-[1.5px] border-accent bg-surface p-6 ring-[5px] ring-accent/10"
      >
        <div className="flex items-start justify-between gap-3">
          <StageHeading title="Connect to the Memex MCP" sub="Use the command below to install the MCP for your coding agent." />
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
            {/* spec-372 issue-6 — OS selector removed; `os` is auto-detected and the
                install command below reflects it without a manual toggle. */}
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
          </>
        )}
      </section>

      {/* Stage 2 — Create your first spec. */}
      <section data-testid="create-stage" className="rounded-2xl border border-edge bg-surface p-6">
        {/* spec-372 issue-17 — the created state is a "✓ Created" badge by the heading,
            mirroring Stage-1's "✓ Connected" badge (not a sentence at the bottom). */}
        <div className="flex items-start justify-between gap-3">
          <StageHeading title="Create your first spec" sub="Draft your first spec with your coding agent, or create it here in the app." />
          {done && <StepDoneBadge label="Created" testId="create-spec-done" />}
        </div>

        <div className="mb-5 inline-flex gap-1 rounded-xl bg-card-hover p-1">
          {(['agent', 'app'] as Method[]).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`method-${m}`}
              onClick={() => {
                setMethod(m);
                onCtaClick?.('create_method');
              }}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                method === m ? 'bg-surface text-accent shadow-sm' : 'text-muted hover:text-secondary'
              }`}
            >
              {m === 'agent' ? 'With your coding agent' : 'In the app'}
            </button>
          ))}
        </div>

        <span className="mb-2.5 block text-sm font-semibold text-primary">Starting point</span>
        <div className="mb-4 flex flex-wrap gap-2.5">
          <button
            type="button"
            data-testid="source-sample"
            onClick={() => {
              setSource('sample');
              onCtaClick?.('starting_point');
            }}
            className={chip(source === 'sample')}
          >
            Use our sample
          </button>
          <button
            type="button"
            data-testid="source-prd"
            onClick={() => {
              setSource('prd');
              onCtaClick?.('starting_point');
            }}
            className={chip(source === 'prd')}
          >
            Point at my PRD
          </button>
        </div>

        {method === 'agent' ? (
          <div data-testid="create-spec-prompt">
            <CodeBlock code={source === 'sample' ? SAMPLE_PROMPT : PRD_PROMPT} onCopy={() => onCtaClick?.('copy_create_prompt')} />
          </div>
        ) : (
          <>
            {/* spec-372 — the in-app method also shows the (fleshed-out) prompt, matching v3. */}
            <div className="mb-4" data-testid="create-spec-app-prompt">
              <CodeBlock
                code={source === 'sample' ? APP_SAMPLE_PROMPT : APP_PRD_PROMPT}
                onCopy={() => onCtaClick?.('copy_create_prompt')}
              />
            </div>
            <button
              type="button"
              data-testid="create-spec-in-app"
              onClick={() => {
                onCtaClick?.('create_spec');
                onCreateInApp?.();
              }}
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-6 py-3.5 text-base font-bold text-on-accent shadow-lg transition hover:bg-accent-hover"
            >
              Create spec in Memex
              <span aria-hidden>→</span>
            </button>
          </>
        )}

        {/* spec-372 issue-17 — done is shown as the "✓ Created" badge by the heading above;
            the bottom status now only carries the waiting line. */}
        {!done && (
          <div className="mt-5" data-testid="create-spec-status">
            <div className="flex items-center gap-2.5 text-sm text-muted">
              <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-full bg-accent" />
              Waiting for your agent to create the spec — this advances the moment it does.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
