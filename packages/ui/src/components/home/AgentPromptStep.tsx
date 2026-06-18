// spec-305 (dec-8) — a reusable "paste a prompt, your agent does it, watch it land"
// card for the SDD-arc steps where the agent does the work: resolve a decision, add
// an acceptance criterion. Polls the step's milestone and advances the moment it's met.
// (create-spec and see-green are bespoke; this covers the two in-between steps.)
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { fetchJourneyStateApi } from '../../api/journey';
import type { JourneyMilestones } from '../../api/journey';

interface StepConfig {
  eyebrow: string;
  headline: string;
  sub: string;
  body: string;
  prompt: string;
  milestone: keyof JourneyMilestones;
  doneLabel: string;
  waitingLabel: string;
}

export const AGENT_PROMPT_STEPS: Record<string, StepConfig> = {
  'resolve-decision': {
    eyebrow: 'Memex · Next',
    headline: 'Make the first real call.',
    sub: 'Every plan hinges on a few decisions.',
    body: 'Have your agent capture the choice your spec turns on as a decision, weigh the options, and resolve it. That is how the plan stays honest and your agent knows which path you picked.',
    prompt: `Using the Memex MCP, on the spec we just created:

1. Call create_decision with the key choice this spec turns on (a clear title + a couple of options).
2. Then resolve it with resolve_decision — pick the option and say why.

Tell me which decision you resolved (dec-N).`,
    milestone: 'hasResolvedDecision',
    doneLabel: 'Decision resolved. Now the acceptance criterion…',
    waitingLabel: 'Waiting for your agent to resolve a decision — this advances the moment it does.',
  },
  'add-ac': {
    eyebrow: 'Memex · Next',
    headline: 'Pin down what "done" means.',
    sub: 'An acceptance criterion turns intent into something testable.',
    body: 'Have your agent add an acceptance criterion to your decision — a plain statement of what the code must do. This is the promise your tests will hold the build to.',
    prompt: `Using the Memex MCP, on the spec we just created:

1. Call create_ac (kind: scope) with a plain-English statement of what "done" looks like for the decision you resolved.

Tell me the AC handle (ac-N) you added — next we'll watch it go green.`,
    milestone: 'hasAc',
    doneLabel: 'Acceptance criterion added. Time for the magic…',
    waitingLabel: 'Waiting for your agent to add an acceptance criterion — this advances the moment it does.',
  },
};

export function AgentPromptStep({
  stepId,
  preview = false,
  onComplete,
}: {
  stepId: string;
  preview?: boolean;
  onComplete?: () => void;
}) {
  const cfg = AGENT_PROMPT_STEPS[stepId];
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    if (preview || !cfg) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (alive && s.milestones?.[cfg.milestone]) {
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
  }, [preview, cfg, onComplete]);

  if (!cfg) return null;

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid={`journey-step-${stepId}`}
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-12"
      >
        <div className="mb-5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{cfg.eyebrow}</div>
        <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">{cfg.headline}</h1>
        <p className="mt-4 text-lg font-semibold text-primary">{cfg.sub}</p>
        <p className="mt-4 max-w-prose leading-relaxed text-secondary">{cfg.body}</p>

        <div className="mt-6" data-testid="agent-prompt">
          <CodeBlock code={cfg.prompt} />
        </div>

        <div className="mt-7" data-testid="agent-prompt-status">
          {done ? (
            <div
              data-testid="agent-prompt-done"
              className="flex items-center gap-3 rounded-xl border border-status-success-border bg-status-success-bg px-4 py-3 text-status-success-text"
            >
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-status-success-text text-base text-white">
                ✓
              </span>
              <span className="font-semibold">{cfg.doneLabel}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
              {cfg.waitingLabel}
            </div>
          )}
        </div>
      </article>
    </div>
  );
}
