// spec-303 — the Home Canvas: a user-level surface (dec-2) and a generic engine
// (dec-1) that renders the current step of the user's journey. It loads journeys
// from the registry and the user's derived position from the server; nothing
// journey-specific lives here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { useUserChangeStream } from '../hooks/useUserChangeStream';
import {
  fetchJourneyStateApi,
  postJourneyEventApi,
  type JourneyStateResponse,
} from '../api/journey';
import { resolveStepView, activeJourney } from '../journeys/registry';
import { JourneyStepShell } from '../components/home/JourneyStepShell';
import { IdentityStep } from '../components/home/IdentityStep';
import type { JourneyCta, JourneyStepView } from '../journeys/types';

type NavMembership = { slug: string; memexSlug?: string | null; kind: string };

function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const f = name.trim().split(/\s+/)[0];
  return f || null;
}

// The path that "begins creating a spec" — the user's personal Memex Specs board
// (mirrors AuthContext's default-landing resolution).
function personalSpecsPath(memberships?: ReadonlyArray<NavMembership>): string | null {
  if (!memberships || memberships.length === 0) return null;
  const personal = memberships.find((m) => m.kind === 'personal') ?? memberships[0];
  const ns = personal.slug;
  const mx = personal.memexSlug ?? (personal.kind === 'personal' ? 'personal' : 'main');
  return `/${ns}/${mx}/specs`;
}

export function HomeCanvas() {
  const { user, session } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const previewParam = searchParams.get('preview');

  const [state, setState] = useState<JourneyStateResponse | null>(null);
  // An in-canvas navigate (e.g. "Why Memex?") that wins until the real step changes.
  const [viewOverride, setViewOverride] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchJourneyStateApi(previewParam)
      .then(setState)
      .catch(() => {
        /* keep last good state — the canvas never hard-crashes on a fetch blip */
      });
  }, [previewParam]);

  useEffect(() => {
    load();
  }, [load]);

  // Live advance (ac-4): refetch on the user's own spec/decision changes, and when
  // the tab refocuses (covers actions taken elsewhere in Memex).
  useUserChangeStream(load, ['document', 'decision']);
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const preview = state?.preview ?? false;
  const serverStepId = state?.currentStepId ?? null;
  const activeStepId = viewOverride ?? serverStepId;

  // Clear the in-canvas override whenever the underlying real step advances.
  useEffect(() => {
    setViewOverride(null);
  }, [serverStepId]);

  // Measurement (ac-7): a step was shown. Real (non-preview) views only.
  useEffect(() => {
    if (activeStepId && !preview) postJourneyEventApi(activeStepId, 'shown');
  }, [activeStepId, preview]);

  const specsPath = useMemo(
    () => personalSpecsPath(session?.memberships as ReadonlyArray<NavMembership> | undefined),
    [session],
  );

  const handleCta = useCallback(
    (cta: JourneyCta) => {
      if (activeStepId && !preview) postJourneyEventApi(activeStepId, 'cta', cta.target);
      // In preview, CTAs are render-only (dec-8): show the step, change nothing.
      if (preview) return;

      if (cta.kind === 'navigate') {
        setViewOverride(cta.target);
        return;
      }
      if (cta.kind === 'link') {
        window.open(cta.target, '_blank', 'noopener,noreferrer');
        return;
      }
      // action — route into the real in-app flow (dec-5). The app owns the handler;
      // the step only names an allow-listed action.
      switch (cta.target) {
        case 'connect_agent':
        case 'invite':
          navigate('/settings/integrations');
          break;
        case 'create_spec':
          // Open the SAME agent-backed NewSpecModal the Specs board uses (?new=1).
          if (specsPath) navigate(`${specsPath}?new=1`);
          break;
        case 'create_decision':
        case 'open_specs':
        default:
          if (specsPath) navigate(specsPath);
          break;
      }
    },
    [activeStepId, preview, navigate, specsPath],
  );

  const journey = activeJourney();
  const view = activeStepId ? resolveStepView(activeStepId) : null;
  // Per-journey, attainment-framed, and never on the cold first step.
  const showMap =
    !!journey.showProgressMap &&
    !!state?.steps?.length &&
    !!activeStepId &&
    activeStepId !== 'welcome' &&
    journey.milestoneStepIds.includes(activeStepId);

  return (
    <div className="min-h-full" data-testid="home-canvas">
      {state?.canPreview && (
        <PreviewBar
          activeStepId={serverStepId}
          onPick={(id) => setSearchParams(id ? { preview: id } : {})}
        />
      )}
      {showMap && state?.steps && (
        <ProgressMap steps={state.steps} currentStepId={activeStepId} views={journey.views} />
      )}
      {activeStepId === 'identity' ? (
        // spec-305 dec-5: the identity step is a custom form (name + role triangle),
        // not a generic CTA card — it persists the captured profile and clears
        // needsOnboarding, after which the journey self-advances.
        <IdentityStep preview={preview} onComplete={load} />
      ) : view ? (
        <JourneyStepShell view={view} userName={firstName(user?.name)} onCta={handleCta} />
      ) : (
        <div className="flex min-h-[70vh] items-center justify-center text-muted">Loading…</div>
      )}
    </div>
  );
}

// Attainment-framed progress map (dec-1, per-journey). Shows every milestone step
// with a tick for what's actually attained — which makes the non-linear skipping
// legible (a later step can be ticked while an earlier one isn't). Highlights the
// step currently on screen. Real attainment, even under preview.
function ProgressMap({
  steps,
  currentStepId,
  views,
}: {
  steps: { id: string; attained: boolean }[];
  currentStepId: string | null;
  views: Record<string, JourneyStepView>;
}) {
  return (
    <div
      data-testid="journey-progress-map"
      className="mx-auto mt-8 flex max-w-3xl items-start justify-center px-4"
    >
      {steps.map((s, i) => {
        const isCurrent = s.id === currentStepId;
        const label = views[s.id]?.mapLabel ?? s.id;
        return (
          <div key={s.id} className="flex items-start">
            {i > 0 && (
              <span
                aria-hidden
                className={`mt-[22px] h-0.5 w-8 flex-none rounded-sm sm:w-16 ${
                  steps[i - 1].attained ? 'bg-status-success-text' : 'bg-edge'
                }`}
              />
            )}
            <div className="flex w-20 flex-col items-center sm:w-24">
              <span
                data-testid={`journey-map-${s.id}`}
                data-attained={s.attained ? 'true' : 'false'}
                className={`flex h-11 w-11 items-center justify-center rounded-full border-2 text-lg font-bold transition ${
                  s.attained
                    ? 'border-status-success-text bg-status-success-text text-white'
                    : isCurrent
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-edge text-muted'
                }`}
              >
                {s.attained ? '✓' : ''}
              </span>
              <span
                className={`mt-2 text-center text-[11px] leading-tight ${
                  isCurrent
                    ? 'font-semibold text-heading'
                    : s.attained
                      ? 'text-secondary'
                      : 'text-muted'
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Internal explainer of the journey concept, shown in the staff-only bar.
function JourneyInfo() {
  return (
    <span className="group relative inline-flex items-center">
      <button
        type="button"
        aria-label="What is a journey?"
        data-testid="journey-info"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-status-warning-border text-[10px] font-bold leading-none text-status-warning-text"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-6 z-50 hidden w-[23rem] rounded-lg border border-edge bg-panel p-3 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-secondary shadow-xl group-hover:block group-focus-within:block"
      >
        <b className="text-heading">This is the onboarding journey.</b> Which card you see
        is determined by your state, not a fixed sequence: the moment your state changes,
        the canvas advances you to the right step. Steps aren&apos;t strictly linear, each
        has its own condition, so already-satisfied steps are skipped. If step 5&apos;s
        condition is met but step 4&apos;s isn&apos;t, you land on step 4, and completing it
        can hop you straight to step 6.
      </span>
    </span>
  );
}

// Operator-only (dec-9): pin any milestone step on your own account to review it
// without minting a new user (dec-8). Render-only — the underlying state is intact.
//
// This bar only renders for entitled operators (server-enforced canPreview), so a
// regular user never sees it. For the Mindset staff who DO see it, the treatment is
// deliberately marked INTERNAL (amber, dashed, a shield + "Mindset only" label and a
// tooltip) so it reads as a staff tool, never a product feature.
function PreviewBar({
  activeStepId,
  onPick,
}: {
  activeStepId: string | null;
  onPick: (id: string | null) => void;
}) {
  const steps = activeJourney().milestoneStepIds;
  return (
    <div
      data-testid="journey-preview-bar"
      title="Mindset staff only: a manual step-switcher for previewing the journey. The Home Canvas and the journey itself are live for every user — only this row of step buttons is staff-only, and using it changes nothing about your real progress."
      className="flex flex-wrap items-center gap-2 border-b border-dashed border-status-warning-border bg-status-warning-bg px-4 py-1.5 text-xs"
    >
      <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider text-status-warning-text">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
        </svg>
        Mindset only · manual step switcher
      </span>
      <JourneyInfo />
      <span className="mx-1 hidden text-status-warning-text/70 sm:inline">|</span>
      {steps.map((id) => (
        <button
          key={id}
          type="button"
          data-testid={`journey-preview-${id}`}
          onClick={() => onPick(id)}
          className={`rounded-md border px-2 py-0.5 ${
            id === activeStepId
              ? 'border-status-warning-border bg-status-warning-bg font-medium text-status-warning-text'
              : 'border-status-warning-border/50 text-status-warning-text/80 hover:bg-status-warning-bg'
          }`}
        >
          {id}
        </button>
      ))}
      <button
        type="button"
        data-testid="journey-preview-live"
        onClick={() => onPick(null)}
        className="rounded-md border border-status-warning-border/50 px-2 py-0.5 text-status-warning-text/80 hover:bg-status-warning-bg"
      >
        Live
      </button>
      <span className="ml-auto hidden text-[10px] normal-case tracking-normal text-status-warning-text/70 md:inline">
        the journey below is live for everyone
      </span>
    </div>
  );
}
