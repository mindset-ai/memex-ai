// spec-421 — step 2 "Create your first spec". Split out from CreateSpecStep's Stage 2
// (spec-336/372). Completes on hasSpec. Simplified: no method/starting-point toggles;
// a blue CTA navigates to the Specs page with ?new=1 to open the New Spec dialog, plus
// a collapsible sample-prompt helper for users who want to use their coding agent.
import { useEffect, useRef, useState } from 'react';
import { CopyButton } from '../CodeBlock';
import { StepDoneBadge } from './StepDoneBadge';
import { fetchJourneyStateApi } from '../../api/journey';
import { SAMPLE_PROMPT } from '../../utils/createSpecPrompts';

export function CreateFirstSpecStep({
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
  const [done, setDone] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const doneRef = useRef(false);
  const initRef = useRef(false);

  useEffect(() => {
    if (preview) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchJourneyStateApi();
        if (!alive) return;
        const hasSpec = !!s.milestones?.hasSpec;
        // First read: if spec already exists the user is revisiting — show done but
        // do NOT advance (spec-336 dec-6: viewing never bumps you forward).
        if (!initRef.current) {
          initRef.current = true;
          if (hasSpec) {
            doneRef.current = true;
            setDone(true);
          }
          return;
        }
        if (hasSpec && !doneRef.current) {
          doneRef.current = true;
          setDone(true);
          setTimeout(() => onComplete?.(), 1400);
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
    <div data-testid="journey-step-create-first-spec" className="animate-[panelIn_0.35s_ease] max-w-3xl">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="onboarding-heading">
            {done ? 'Created your first spec' : 'Create your first spec'}
          </h2>
        </div>
        {done && <StepDoneBadge label="Created" testId="create-first-spec-done" />}
      </div>

      {done ? (
        <p className="mb-6 text-xl font-medium leading-snug text-primary">
          Nice work — your first spec is in Memex. You&apos;re all set.
        </p>
      ) : (
        <>
          <p className="mb-8 text-xl font-medium leading-snug text-primary">
            Get the full magic of Memex by connecting to the MCP and using it in your Agent
          </p>

          {/* Primary CTA — opens New Spec dialog on the Specs page via ?new=1 (dec-4). */}
          <button
            type="button"
            data-testid="create-first-spec-btn"
            onClick={() => {
              onCtaClick?.('create_spec');
              onCreateInApp?.();
            }}
            className="mb-8 inline-flex items-center gap-2 rounded-xl bg-accent px-6 py-3.5 text-base font-bold text-on-accent shadow-lg transition hover:bg-accent-hover"
          >
            Create your first spec
            <span aria-hidden>→</span>
          </button>

          {/* Sample prompt helper — collapsible, ~10 lines visible, copy button. */}
          <div data-testid="sample-prompt-helper" className="rounded-2xl border border-edge bg-surface p-5">
            <p className="mb-3 text-sm text-secondary">
              Need some help getting started? Use our sample prompt to create a spec in your Agent.
            </p>
            <div className="relative">
              {/* Truncated to ~10 lines (line-height ~1.5 × 14px font ≈ 21px × 10 = 210px). */}
              <div
                data-testid="sample-prompt-container"
                className={`overflow-hidden transition-all duration-300 ${expanded ? '' : 'max-h-[13rem]'}`}
              >
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-edge bg-surface p-4 pr-20 text-sm leading-relaxed text-primary">
                  <code>{SAMPLE_PROMPT}</code>
                </pre>
              </div>
              <div className="absolute right-2 top-2">
                <CopyButton text={SAMPLE_PROMPT} onCopy={() => onCtaClick?.('copy_create_prompt')} />
              </div>
              {!expanded && (
                <div className="absolute bottom-0 left-0 right-0 flex justify-center bg-gradient-to-t from-surface pb-2 pt-8">
                  <button
                    type="button"
                    data-testid="sample-prompt-expand"
                    onClick={() => setExpanded(true)}
                    className="rounded-md bg-card-hover px-3 py-1 text-xs font-semibold text-secondary transition hover:text-primary"
                  >
                    Show more
                  </button>
                </div>
              )}
            </div>
            {expanded && (
              <button
                type="button"
                data-testid="sample-prompt-collapse"
                onClick={() => setExpanded(false)}
                className="mt-2 text-xs font-semibold text-secondary transition hover:text-primary"
              >
                Show less
              </button>
            )}
          </div>

          <div className="mt-5" data-testid="create-first-spec-status">
            <div className="flex items-center gap-2.5 text-sm text-muted">
              <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-full bg-accent" />
              Waiting for your agent to create the spec — this advances the moment it does.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
