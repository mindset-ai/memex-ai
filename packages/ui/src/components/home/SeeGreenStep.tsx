// spec-305 dec-8 — the aha. The user has a spec, a decision, and an acceptance
// criterion; now they have their agent emit a passing test tagged to that AC and
// watch it turn GREEN right here. Provable alignment between intent and code — the
// whole point of Memex. Polls acVerified; on green, a celebration, then advance.
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { fetchJourneyStateApi } from '../../api/journey';

const PROMPT = `Using the Memex MCP, on the acceptance criterion we just added:

1. Write (or point me at) a test that backs that AC.
2. Run it, then emit the result to Memex tagged to the AC handle (ac-N) as a pass.

When the test passes, the AC turns green right here.`;

export function SeeGreenStep({
  preview = false,
  onComplete,
  onCtaClick,
}: {
  preview?: boolean;
  onComplete?: () => void;
  // spec-324 — record the step's primary CTA (copy the prompt) as home_canvas.cta_clicked.
  onCtaClick?: (target: string) => void;
} = {}) {
  const [green, setGreen] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    if (preview) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (alive && s.milestones?.acVerified) {
          setGreen(true);
          if (!doneRef.current) {
            doneRef.current = true;
            setTimeout(() => onComplete?.(), 2200);
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
        data-testid="journey-step-see-green"
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 text-center shadow-2xl backdrop-blur-xl sm:p-14"
      >
        {green ? (
          <div data-testid="see-green-done">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-status-success-text text-4xl text-white shadow-lg">
              ✓
            </div>
            <h1 className="mt-6 text-4xl font-black tracking-tight text-heading sm:text-5xl">Green.</h1>
            <p className="mt-4 text-lg font-semibold text-primary">
              Your acceptance criterion just went green from a real test.
            </p>
            <p className="mt-3 leading-relaxed text-secondary">
              Intent and code, provably in lockstep. You drove a spec from an idea to a verified result — that
              is the whole loop. This is Memex.
            </p>
          </div>
        ) : (
          <div className="text-left">
            <div className="mb-5 font-mono text-xs lowercase tracking-tight text-muted">// 05 · the moment</div>
            <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
              Watch it go green.
            </h1>
            <p className="mt-4 text-lg font-semibold text-primary">
              Your agent emits a test result, and the AC lights up.
            </p>
            <p className="mt-4 max-w-prose leading-relaxed text-secondary">
              Have your agent run the test that backs your acceptance criterion. When it passes, the AC turns
              green right here — provable alignment between what you intended and what the code does.
            </p>
            <div className="mt-6" data-testid="see-green-prompt">
              <CodeBlock code={PROMPT} onCopy={() => onCtaClick?.('copy_prompt')} />
            </div>
            <div className="mt-7 flex items-center gap-2 text-sm text-muted">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
              Waiting for a passing test on your AC — the moment it lands, this turns green.
            </div>
          </div>
        )}
      </article>
    </div>
  );
}
