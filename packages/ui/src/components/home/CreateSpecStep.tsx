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

// spec-372 change #11 — the four Stage-2 prompts now instruct the agent to create AND
// fully flesh out a complete, build-ready spec (scope ACs + surface decisions), not just
// create_doc. Agent variants are MCP step lists; the in-app variants are natural-language
// prompts pasted into Memex's own creator.
const SAMPLE_PROMPT = `Using the Memex MCP, create and fully flesh out my first spec in my personal Memex from:

  "Orders Dashboard — a small internal dashboard over a sample sales DB
   (à la Northwind): list orders, filter by customer and date, and a
   revenue-by-month chart."

1. Call list_memexes and pick my personal workspace.
2. Call create_doc with the title "Orders Dashboard" and a clear purpose.
3. Add scope acceptance criteria capturing what "done" looks like.
4. Surface the decisions the build hinges on for me to resolve.
5. Leave it fully fleshed out — not just a stub — so all that's left is for me to resolve the decisions and build.

Then tell me the spec handle (spec-N) you created.`;

const PRD_PROMPT = `Using the Memex MCP, create and fully flesh out my first spec in my personal Memex from my PRD:

1. Read my PRD at ./docs/prd.md locally.
2. Call list_memexes and pick my personal workspace.
3. Call create_doc with a title and a clear purpose drawn from the PRD.
4. Add scope acceptance criteria capturing what "done" looks like.
5. Surface the decisions the build hinges on for me to resolve.
6. Leave it fully fleshed out — not just a stub — so all that's left is for me to resolve the decisions and build.

Then tell me the spec handle (spec-N) you created.`;

const APP_SAMPLE_PROMPT = `Create and fully flesh out a spec for an Orders Dashboard — a small internal
dashboard over a sample sales DB (à la Northwind): list orders, filter by
customer and date, and a revenue-by-month chart.

Give it a clear purpose, add scope acceptance criteria for what "done" looks
like, and raise the key decisions for me to resolve — so it's fully fleshed
out, not just a stub.`;

const APP_PRD_PROMPT = `Create and fully flesh out a spec from my PRD at ./docs/prd.md — draw the
title and purpose from it and keep the scope to what the PRD describes.

Add scope acceptance criteria for what "done" looks like, and raise the key
decisions for me to resolve — so it's fully fleshed out, not just a stub.`;

// spec-372 change #13 — the "Copy a prompt for your agent" clipboard payload (Ryan-
// supplied; doc-grounded MCP evaluation prompt). The design's own placeholder is replaced
// by this authoritative text.
const EXPLORE_PROMPT = `Fetch and read the Memex documentation at https://www.memex.ai/docs.

Memex is a "living specification and verification layer" that connects to
AI coding agents like you over MCP. I'm evaluating whether to install it.

Based only on what's in that documentation:

1. Explain what Memex is and the problem it solves, in plain terms.
2. Explain how the MCP connection works and what you (my coding agent)
   would be able to do once connected.
3. Tell me the exact steps to connect Memex to the specific tool you are
   running in right now.

Keep everything grounded in the documentation — if something isn't covered
there, say so rather than guessing. Then let me ask follow-up questions,
and when I'm ready, walk me through installing it.`;

const DOCS_HREF = 'https://www.memex.ai/docs#mcp-tools-reference';

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

  const osMatters = tool === 'claude-code' || tool === 'claude-desktop';

  return (
    <div data-testid="journey-step-create-spec" className="animate-[panelIn_0.35s_ease] max-w-3xl">
      <h2 className="onboarding-heading mb-4">
        Build exactly what you decided
      </h2>
      <p className="mb-4 text-xl font-bold leading-snug text-primary">
        Get the full magic of <GlossaryTerm term="spec">Memex</GlossaryTerm> by connecting to the MCP and using it in
        your coding agent
      </p>
      {/* spec-372 change #13 — "New to the MCP?" helper: docs link + Copy-a-prompt-for-your-agent. */}
      <p className="mb-7 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary">
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
          className="inline-flex items-center gap-1.5 rounded-md bg-card-hover px-3 py-1.5 font-semibold text-secondary transition hover:text-primary"
        >
          {exploreCopied ? 'Copied!' : 'Copy a prompt for your agent'}
        </button>
      </p>

      {/* Stage 1 — Connect to Memex MCP (reuses the real per-tool/OS installer). */}
      <section data-testid="connect-stage" className="mb-4 rounded-2xl border border-edge bg-surface/60 p-6">
        <div className="flex items-start justify-between gap-3">
          <StageHeading n={1} title="Connect to the Memex MCP" sub="Use the command below to install the MCP for your coding agent." />
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
      <section data-testid="create-stage" className="rounded-2xl border border-edge bg-surface/60 p-6">
        <StageHeading n={2} title="Create your first spec" sub="Draft your first spec with your coding agent, or create it here in the app." />

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
