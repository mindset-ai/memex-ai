// spec-305 dec-9 — the create-spec step. With the agent connected, the user pastes a
// prompt and the agent creates the spec over MCP. No blank page: bring your own
// PRD/markdown, or use our built-in sample. A live tick advances the moment the spec
// exists (hasSpec milestone). The agent reads the source locally — no Memex-side upload.
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { fetchJourneyStateApi } from '../../api/journey';

type Source = 'prd' | 'sample';

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

export function CreateSpecStep({
  preview = false,
  onComplete,
}: {
  preview?: boolean;
  onComplete?: () => void;
} = {}) {
  const [source, setSource] = useState<Source>('sample');
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);

  // Live tick: poll for the hasSpec milestone, then advance.
  useEffect(() => {
    if (preview) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (alive && s.milestones?.hasSpec) {
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
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid="journey-step-create-spec"
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-12"
      >
        <div className="mb-5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Memex · Next</div>
        <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
          Hand your agent its first spec.
        </h1>
        <p className="mt-4 text-lg font-semibold text-primary">No blank page — bring a PRD, or use ours.</p>
        <p className="mt-4 max-w-prose leading-relaxed text-secondary">
          Paste this into your connected agent. It reads your source locally and creates the spec in your
          personal Memex over MCP — nothing to upload here.
        </p>

        <div className="mt-7">
          <span className="mb-2 block text-sm font-medium text-secondary">What should the spec be about?</span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="source-sample"
              onClick={() => setSource('sample')}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                source === 'sample'
                  ? 'border-accent bg-accent/10 font-medium text-accent'
                  : 'border-edge text-secondary hover:bg-card-hover'
              }`}
            >
              Use our sample
            </button>
            <button
              type="button"
              data-testid="source-prd"
              onClick={() => setSource('prd')}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                source === 'prd'
                  ? 'border-accent bg-accent/10 font-medium text-accent'
                  : 'border-edge text-secondary hover:bg-card-hover'
              }`}
            >
              Point at my PRD
            </button>
          </div>
        </div>

        <div className="mt-4" data-testid="create-spec-prompt">
          <CodeBlock code={source === 'sample' ? SAMPLE_PROMPT : PRD_PROMPT} />
        </div>

        <div className="mt-7" data-testid="create-spec-status">
          {done ? (
            <div
              data-testid="create-spec-done"
              className="flex items-center gap-3 rounded-xl border border-status-success-border bg-status-success-bg px-4 py-3 text-status-success-text"
            >
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-status-success-text text-base text-white">
                ✓
              </span>
              <span className="font-semibold">Spec created. On to the first decision…</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
              Waiting for your agent to create the spec — this advances the moment it does.
            </div>
          )}
        </div>
      </article>
    </div>
  );
}
