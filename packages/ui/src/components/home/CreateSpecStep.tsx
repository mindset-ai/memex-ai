// spec-336 — step 1 "Create your spec" (v2). Flat, full-width, two numbered stages:
// Stage 1 connects the coding agent to Memex over MCP (reusing the built per-tool/OS
// installer — dec-4, never the flat INT one-liner), Stage 2 creates the first spec with
// that agent or in the app. The STEP advances on the hasSpec milestone; Stage 1's
// connection shows inline (a green tick on mcpConnected) but is not itself a gate.
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { GlossaryTerm } from '../GlossaryTerm';
import { fetchJourneyStateApi } from '../../api/journey';
import { Instructions, TOOLS, OS_LABEL, detectOs, type Os, type Tool } from './ConnectAgentStep';

type Source = 'prd' | 'sample';
type Method = 'agent' | 'app';

const PRD_PROMPT = `Using the Memex MCP, create my first spec in my personal Memex.

1. Call list_memexes and pick my personal workspace.
2. Read the PRD I point you at (e.g. ./PRD.md) — ask me for the path if you need it.
3. Call create_doc with a clear title and a purpose drawn from the PRD.

Then tell me the spec handle (spec-N) you created.`;

const SAMPLE_PROMPT = `Using the Memex MCP, create my first spec in my personal Memex from this short sample:

  "Orders Dashboard — a small internal dashboard over a sample sales database
   (à la Northwind): list orders, filter by customer and date, and show a
   revenue-by-month chart."

1. Call list_memexes and pick my personal workspace.
2. Call create_doc with the title "Orders Dashboard" and a purpose based on the sample above.

Then tell me the spec handle (spec-N) you created — we'll add a decision and an
acceptance criterion next.`;

const chip = (selected: boolean) =>
  `rounded-lg border px-4 py-2 text-sm transition ${
    selected ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-edge text-secondary hover:bg-card-hover'
  }`;

function StageHeading({ n, title, sub }: { n: number; title: string; sub: string }) {
  return (
    <div className="mb-4 flex items-center gap-3.5">
      <div className="flex-none font-mono text-3xl font-medium leading-none text-muted">{n}</div>
      <div>
        <div className="text-lg font-bold leading-tight text-heading">{title}</div>
        <div className="mt-0.5 text-sm text-muted">{sub}</div>
      </div>
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
  const [os, setOs] = useState<Os>(detectOs);
  const [tool, setTool] = useState<Tool>('claude-code');
  const [method, setMethod] = useState<Method>('agent');
  const [source, setSource] = useState<Source>('sample');
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);
  const initRef = useRef(false);

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

  const osMatters = tool === 'claude-code' || tool === 'claude-desktop';

  return (
    <div data-testid="journey-step-create-spec" className="animate-[panelIn_0.35s_ease] max-w-3xl">
      <h2 className="mb-4 text-5xl font-black leading-[1.04] tracking-tight text-heading">
        Build exactly what you decided.
      </h2>
      <p className="mb-4 text-xl font-bold leading-snug text-primary">
        Turn intent into a living spec your agents follow.
      </p>
      <p className="mb-7 leading-relaxed text-secondary">
        Connect your agent to Memex over MCP, then create a <GlossaryTerm term="spec">spec</GlossaryTerm> with your
        coding agent or in the app.
      </p>

      {/* Stage 1 — Connect to Memex MCP (reuses the real per-tool/OS installer). */}
      <section data-testid="connect-stage" className="mb-4 rounded-2xl border border-edge bg-surface/60 p-6">
        <div className="flex items-start justify-between gap-3">
          <StageHeading n={1} title="Connect to Memex MCP" sub="One install. Authorises this device and adds Memex to your agent's MCP config." />
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
            {osMatters && (
              <div className="mb-3">
                <span className="mb-2 block text-sm font-medium text-secondary">Your machine</span>
                <div className="flex flex-wrap gap-2">
                  {(['mac', 'windows', 'linux'] as Os[]).map((o) => (
                    <button key={o} type="button" data-testid={`os-${o}`} onClick={() => setOs(o)} className={chip(o === os)}>
                      {OS_LABEL[o]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-3">
              <span className="mb-2 block text-sm font-medium text-secondary">Your coding agent</span>
              <div className="flex flex-wrap gap-2">
                {TOOLS.map((t) => (
                  <button key={t.id} type="button" data-testid={`tool-${t.id}`} onClick={() => setTool(t.id)} className={chip(t.id === tool)}>
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
      <section data-testid="create-stage" className="rounded-2xl border border-edge bg-surface/60 p-6">
        <StageHeading n={2} title="Create your first spec" sub="Draft it with your coding agent, or create it here in the app." />

        <div className="mb-5 inline-flex gap-1 rounded-xl bg-card-hover p-1">
          {(['agent', 'app'] as Method[]).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`method-${m}`}
              onClick={() => setMethod(m)}
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
          <button type="button" data-testid="source-sample" onClick={() => setSource('sample')} className={chip(source === 'sample')}>
            Use our sample
          </button>
          <button type="button" data-testid="source-prd" onClick={() => setSource('prd')} className={chip(source === 'prd')}>
            Point at my PRD
          </button>
        </div>

        {method === 'agent' ? (
          <div data-testid="create-spec-prompt">
            <CodeBlock code={source === 'sample' ? SAMPLE_PROMPT : PRD_PROMPT} onCopy={() => onCtaClick?.('copy_prompt')} />
          </div>
        ) : (
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
        )}

        <div className="mt-5" data-testid="create-spec-status">
          {done ? (
            <div data-testid="create-spec-done" className="flex items-center gap-2.5 text-status-success-text">
              <span className="h-2.5 w-2.5 flex-none rounded-full bg-status-success-text" />
              <span className="font-semibold">Connected — and your first spec is in Memex.</span>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 text-sm text-muted">
              <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-full bg-accent" />
              Waiting for your agent to create the spec — this advances the moment it does.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
