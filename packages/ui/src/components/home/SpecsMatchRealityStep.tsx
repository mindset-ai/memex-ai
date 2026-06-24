// spec-336 — step 4 "Improved from your code" (BUILDER-ONLY), v2 flat layout. With access
// to the repo, the agent grounds the whole plan in what's actually there: decisions + ACs
// are refined, the work is broken into tasks, and a unit test is written for each AC. A
// copyable prompt drives the stage; four product shots show the four outcomes (caption +
// description above each). Advances on the planGrounded milestone (spec-337). The product
// shots are ALWAYS DARK regardless of theme (the design ships dark assets), so each sits on
// its own fixed-dark surface rather than theme tokens.
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { fetchJourneyStateApi } from '../../api/journey';
import shotDecisions from '../../assets/onboarding/specs-match-reality-1-decisions-improved.png';
import shotAcs from '../../assets/onboarding/specs-match-reality-2-acceptance-criteria-improved.png';
import shotTasks from '../../assets/onboarding/specs-match-reality-3-tasks-created.png';
import shotTests from '../../assets/onboarding/specs-match-reality-4-unit-tests.png';

const IMPROVE_PROMPT = `Using the Memex MCP, with access to my repo:

Improve the spec, decisions and acceptance criteria against the
reality of the codebase. Then break the work into tasks and add a
unit test for each acceptance criterion.`;

const OUTCOMES: ReadonlyArray<{ img: string; title: string; desc: string }> = [
  { img: shotDecisions, title: 'Decisions improved against the codebase', desc: 'Each choice is re-checked against what the code already does.' },
  { img: shotAcs, title: 'Acceptance criteria improved against the codebase', desc: 'Criteria sharpen to match real interfaces and edge cases.' },
  { img: shotTasks, title: 'Tasks created automatically', desc: 'The work is broken into ordered, scoped tasks.' },
  { img: shotTests, title: 'Unit tests written for each AC', desc: 'Every criterion gets a test that proves it.' },
];

export function SpecsMatchRealityStep({
  preview = false,
  onComplete,
  onCtaClick,
}: {
  preview?: boolean;
  onComplete?: () => void;
  onCtaClick?: (target: string) => void;
} = {}) {
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
        const met = !!s.milestones?.planGrounded;
        // First read after this step opens. If planGrounded is already met the user is
        // REVISITING a completed step — show it as done but do NOT advance them off it
        // (spec-336 dec-6: viewing never bumps you forward). Only a transition observed
        // while the step is open advances the canvas.
        if (!initRef.current) {
          initRef.current = true;
          if (met) {
            doneRef.current = true;
            setDone(true);
          }
          return;
        }
        if (met) {
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
    <div data-testid="journey-step-specs-match-reality" className="max-w-3xl animate-[panelIn_0.35s_ease]">
      <h2 className="onboarding-heading mb-4">Specs that match reality</h2>
      {/* spec-372 t-13 — v3 sub-tagline weight is 600 (semibold), not bold. */}
      <p className="mb-5 text-xl font-semibold leading-snug text-primary">Refined against your actual codebase</p>
      <p className="mb-6 max-w-2xl leading-relaxed text-secondary">
        With access to the repo, your agent grounds the whole plan in what&apos;s actually there: decisions and
        acceptance criteria are refined, the work is broken into tasks, and a unit test is written for each AC.
      </p>

      <div className="mb-7" data-testid="specs-match-reality-prompt">
        <CodeBlock code={IMPROVE_PROMPT} onCopy={() => onCtaClick?.('copy_prompt')} />
      </div>

      <div className="flex flex-col gap-8" data-testid="specs-match-reality-outcomes">
        {OUTCOMES.map((o) => (
          <figure key={o.title} className="m-0">
            <figcaption>
              <div className="text-base font-semibold text-heading">{o.title}</div>
              <div className="mt-1.5 max-w-xl text-sm leading-snug text-secondary">{o.desc}</div>
            </figcaption>
            {/* Always-dark region — the assets are dark exports; do not theme this.
                spec-372 t-3 (change #4) — the shot fills the content column so it matches the
                width of the prompt container above (v3 renders these full-width). */}
            <div className="mt-3.5 w-full overflow-hidden rounded-xl border border-white/10 bg-slate-950 p-2">
              <img src={o.img} alt={o.title} loading="lazy" className="block w-full rounded-lg" />
            </div>
          </figure>
        ))}
      </div>

      <div className="mt-7" data-testid="specs-match-reality-status">
        {done ? (
          <div data-testid="specs-match-reality-done" className="flex items-center gap-2.5 text-status-success-text">
            <span className="h-2.5 w-2.5 flex-none rounded-full bg-status-success-text" />
            <span className="font-semibold">Plan grounded in your codebase.</span>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 text-sm text-muted">
            {/* spec-372 dec-4 — honest waiting copy + a STATIC (non-pulsing) idle dot, so the
                step never implies Memex is autonomously operating in the user's repo. */}
            <span className="h-2.5 w-2.5 flex-none rounded-full bg-current opacity-50" />
            Waiting for your agent to ground the plan in your codebase — this advances the moment it does.
          </div>
        )}
      </div>
    </div>
  );
}
