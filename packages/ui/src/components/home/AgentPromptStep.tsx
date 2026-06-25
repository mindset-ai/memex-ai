// spec-305 (dec-8) — a reusable "paste a prompt, your agent does it, watch it land"
// card for the SDD-arc steps where the agent does the work: resolve a decision, add
// an acceptance criterion. Polls the step's milestone and advances the moment it's met.
// (create-spec and see-green are bespoke; this covers the two in-between steps.)
import { useEffect, useRef, useState } from 'react';
import { CodeBlock } from '../CodeBlock';
import { StepDoneBadge } from './StepDoneBadge';
import { SPEC_TOKEN_PLACEHOLDER } from './specToken';
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

// spec-336 — the v2 copy + verbatim design prompts for the two paste-a-prompt SDD
// steps. "Decisions raised" and "Acceptance criteria raised" are the same move: point
// your agent at the spec and the repo and it raises the work; you only resolve.
export const AGENT_PROMPT_STEPS: Record<string, StepConfig> = {
  'resolve-decision': {
    eyebrow: 'Decisions raised',
    headline: 'No agent decides for you',
    sub: 'Hidden calls surface before a line is written',
    body: 'Point your agent at the spec and the repo. It reads both and raises the decisions that need taking, so all you do is resolve them.',
    // spec-372 issue-13 — {spec} is replaced at render with the user's real spec handle
    // (or a fill-in placeholder); see specToken.ts / resolveSpecToken.
    prompt: `Using the Memex MCP:

Look at {spec}, look at the repo, and update the spec by raising the key decisions that need to be made.

Then tell me which decisions (dec-N) you raised.`,
    milestone: 'hasResolvedDecision',
    doneLabel: 'Decisions raised on your spec.',
    waitingLabel: 'Waiting for your agent to raise decisions — this advances the moment it does.',
  },
  'add-ac': {
    eyebrow: 'Acceptance criteria raised',
    headline: 'Done becomes a fact',
    sub: 'Testable criteria, set before the build starts',
    body: 'Same move: your agent reads the spec and the repo and raises testable acceptance criteria against each decision.',
    // spec-372 issue-14 — {spec} replaced at render; last line corrected to acceptance criteria.
    prompt: `Using the Memex MCP:

Look at {spec}, look at the repo, and update the spec by raising acceptance criteria for each decision.

Then tell me the acceptance criteria (ac-N) you added.`,
    milestone: 'hasAc',
    doneLabel: 'Acceptance criteria raised.',
    waitingLabel: 'Waiting for your agent to raise acceptance criteria — this advances the moment it does.',
  },
};

export function AgentPromptStep({
  stepId,
  preview = false,
  onComplete,
  onCtaClick,
  specToken = SPEC_TOKEN_PLACEHOLDER,
}: {
  stepId: string;
  preview?: boolean;
  onComplete?: () => void;
  // spec-324 — record the step's primary CTA (copy the prompt) as home_canvas.cta_clicked.
  onCtaClick?: (target: string) => void;
  // spec-372 issues 13/14 — the real spec handle (or placeholder) injected into the prompt.
  specToken?: string;
}) {
  const cfg = AGENT_PROMPT_STEPS[stepId];
  const [done, setDone] = useState(false);
  const doneRef = useRef(false);
  const initRef = useRef(false);

  useEffect(() => {
    if (preview || !cfg) return;
    // This component is reused across resolve-decision ↔ add-ac (same instance, new
    // stepId), so reset the per-step trackers whenever the step changes.
    initRef.current = false;
    doneRef.current = false;
    setDone(false);
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (!alive) return;
        const met = !!s.milestones?.[cfg.milestone];
        // First read after this step opens. If the milestone is already met the user is
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
  }, [preview, cfg, onComplete]);

  if (!cfg) return null;

  return (
    <div data-testid={`journey-step-${stepId}`} className="max-w-3xl animate-[panelIn_0.35s_ease]">
      {/* spec-372 issue-17 — done is a "✓ {eyebrow}" badge inline with the title, right-aligned
          to the content; the bottom status carries only the waiting line. */}
      <div className="flex items-start justify-between gap-3">
        <h2 className="onboarding-heading mb-4">{cfg.headline}</h2>
        {done && <StepDoneBadge label={cfg.eyebrow} testId="agent-prompt-done" />}
      </div>
      {/* spec-372 t-13 — v3 sub-tagline weight is 600 (semibold), not bold. */}
      <p className="mb-5 text-xl font-semibold leading-snug text-primary">{cfg.sub}</p>
      <p className="mb-7 max-w-2xl leading-relaxed text-secondary">{cfg.body}</p>

      <div data-testid="agent-prompt">
        <CodeBlock code={cfg.prompt.replace('{spec}', specToken)} onCopy={() => onCtaClick?.('copy_prompt')} />
      </div>

      {!done && (
        <div className="mt-5" data-testid="agent-prompt-status">
          <div className="flex items-center gap-2.5 text-sm text-muted">
            <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-full bg-accent" />
            {cfg.waitingLabel}
          </div>
        </div>
      )}
    </div>
  );
}
