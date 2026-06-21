// spec-303 — the Home Canvas: a user-level surface (dec-2) and a generic engine
// (dec-1) that renders the current step of the user's journey. It loads journeys
// from the registry and the user's derived position from the server; nothing
// journey-specific lives here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { useUserChangeStream } from '../hooks/useUserChangeStream';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  fetchJourneyStateApi,
  postJourneyEventApi,
  type JourneyStateResponse,
} from '../api/journey';
import { resolveStepView, activeJourney } from '../journeys/registry';
import { isJourneyGraduated } from '../journeys/graduation';
import { YourJourneys, type PearlJourney } from '../components/home/YourJourneys';
import { HomeValue } from '../components/home/HomeValue';
import { JourneyStepShell } from '../components/home/JourneyStepShell';
import { IdentityStep } from '../components/home/IdentityStep';
import { ConnectAgentStep } from '../components/home/ConnectAgentStep';
import { CreateSpecStep } from '../components/home/CreateSpecStep';
import { AgentPromptStep } from '../components/home/AgentPromptStep';
import { SeeGreenStep } from '../components/home/SeeGreenStep';
import { WelcomeStep } from '../components/home/WelcomeStep';
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

  // spec-318 (ac-17): the Home Canvas is the one top-level page that does NOT use
  // PageHeader, so it sets its own document.title. The desktop shell reads
  // document.title to label the tab — without this the /home tab keeps whatever
  // the previous page set (e.g. "Specs"). Set unconditionally at the top so it
  // applies across all of this component's conditional render branches.
  useDocumentTitle({ kind: 'page', title: 'Home' });

  const [state, setState] = useState<JourneyStateResponse | null>(null);
  // An in-canvas navigate (e.g. "Why Memex?") that wins until the real step changes.
  const [viewOverride, setViewOverride] = useState<string | null>(null);
  // spec-305 dec-7: while the connect-agent reward is showing, linger on it so a
  // focus-refetch (the user tabbing back from their terminal) can't skip past it.
  const [lingerStep, setLingerStep] = useState<string | null>(null);

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
  const displayStepId = lingerStep ?? activeStepId;

  // Clear the in-canvas override whenever the underlying real step advances.
  useEffect(() => {
    setViewOverride(null);
  }, [serverStepId]);

  // Measurement (ac-7): a milestone step was shown. Real (non-preview) views only, and
  // only server milestone steps — informational client views (why-memex, learn-more)
  // aren't valid step ids server-side and would 400.
  useEffect(() => {
    if (displayStepId && !preview && activeJourney().milestoneStepIds.includes(displayStepId)) {
      postJourneyEventApi(displayStepId, 'shown');
    }
  }, [displayStepId, preview]);

  const specsPath = useMemo(
    () => personalSpecsPath(session?.memberships as ReadonlyArray<NavMembership> | undefined),
    [session],
  );

  const handleCta = useCallback(
    (cta: JourneyCta) => {
      if (activeStepId && !preview && activeJourney().milestoneStepIds.includes(activeStepId)) {
        postJourneyEventApi(activeStepId, 'cta', cta.target);
      }
      // A 'navigate' CTA only changes the in-canvas view — it writes nothing, so it works
      // even in operator preview. Only data-writing actions/links are sandboxed (dec-8).
      if (cta.kind === 'navigate') {
        setViewOverride(cta.target);
        return;
      }
      if (preview) return;
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

  // spec-324 — record a custom-step's primary CTA click as home_canvas.cta_clicked.
  // The generic JourneyStepShell steps already record via handleCta; this gives the
  // bespoke step components (identity, connect-agent, create-spec, …) the same intent
  // signal. Same gating as the step_shown / handleCta measurement: real milestone
  // steps only, never operator preview.
  const trackStepCta = useCallback(
    (target: string) => {
      if (displayStepId && !preview && activeJourney().milestoneStepIds.includes(displayStepId)) {
        postJourneyEventApi(displayStepId, 'cta', target);
      }
    },
    [displayStepId, preview],
  );

  const journey = activeJourney();
  const view = displayStepId ? resolveStepView(displayStepId) : null;
  // Per-journey, attainment-framed, and never on the cold first step.
  const showMap =
    !!journey.showProgressMap &&
    !!state?.steps?.length &&
    !!displayStepId &&
    displayStepId !== 'welcome' &&
    journey.milestoneStepIds.includes(displayStepId);

  // spec-312 dec-2: Home is LAYERED. The journey is a layer that recedes as the user
  // progresses — expanded while not graduated, collapsed (to pearls) once graduated.
  // `graduated` is consumed only through this seam (isJourneyGraduated) and never
  // decides whether the home-of-value content renders; that is always the page.
  const graduated = isJourneyGraduated(state);
  // Collapse defaults to the graduated signal but is user-overridable — collapsing is
  // escapable (the pearls re-open it) and never erases the journey (dec-4).
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  const collapsed = collapsedOverride ?? graduated;

  // spec-312 dec-4: one pearl row per journey, derived from real activity (state.steps).
  // Built for N journeys; v0 ships with the single active journey.
  const pearlJourneys: PearlJourney[] = useMemo(() => {
    if (!state?.steps?.length) return [];
    return [
      {
        id: journey.id,
        title: 'Getting started',
        steps: state.steps.map((s) => ({
          id: s.id,
          label: journey.views[s.id]?.mapLabel ?? s.id,
          attained: s.attained,
        })),
      },
    ];
  }, [state, journey]);

  return (
    <div className="min-h-full" data-testid="home-canvas">
      {state?.canPreview && (
        <PreviewBar
          activeStepId={serverStepId}
          onPick={(id) => setSearchParams(id ? { preview: id } : {})}
        />
      )}

      {/* dec-2: the journey LAYER — shown expanded while not collapsed (onboarding).
          Once graduated/collapsed it disappears, leaving the home-of-value + the pearls. */}
      {!collapsed && (
        <section data-testid="journey-layer" className="relative">
          <div className="mx-auto flex max-w-3xl justify-end px-4 pt-4">
            <button
              type="button"
              data-testid="journey-collapse"
              onClick={() => setCollapsedOverride(true)}
              className="text-xs font-medium text-muted hover:text-secondary"
            >
              Collapse
            </button>
          </div>
          {showMap && state?.steps && (
            <ProgressMap steps={state.steps} currentStepId={displayStepId} views={journey.views} />
          )}
          {renderJourneyStep()}
        </section>
      )}

      {/* spec-315 dec-3: the home-of-value surface (where-you're-needed + specs-in-flight)
          is the page; the top is reserved for what needs the user now. */}
      <HomeValue specsPath={specsPath} />

      {/* spec-315 dec-3: the journey pearls are RELOCATED to the bottom — a finished
          journey is a static green-pearl trail that must not own the top. Still the
          persistent, escapable-but-never-erasable re-entry point (spec-312 dec-4). */}
      <YourJourneys journeys={pearlJourneys} onOpen={() => setCollapsedOverride(false)} />
    </div>
  );

  function renderJourneyStep() {
    return displayStepId === 'welcome' ? (
        // spec-305 — the welcome card; "Why Memex?" grows it in place into a short lesson.
        <WelcomeStep onNavigate={(t) => setViewOverride(t)} onCtaClick={trackStepCta} />
      ) : displayStepId === 'identity' ? (
        // spec-305 dec-5: the identity step is a custom form (name + role triangle),
        // not a generic CTA card — it persists the captured profile and clears
        // needsOnboarding, after which the journey self-advances.
        <IdentityStep preview={preview} onComplete={load} onCtaClick={trackStepCta} />
      ) : displayStepId === 'connect-agent' ? (
        // spec-305 dec-7: the rich connect-MCP card. On connect it flips to a reward
        // state ("your agent is now Memex-native") which we LINGER on (so a focus-
        // refetch can't skip it); it advances on the first tool call or Next.
        <ConnectAgentStep
          preview={preview}
          onConnected={() => setLingerStep('connect-agent')}
          onCtaClick={trackStepCta}
          onComplete={() => {
            setLingerStep(null);
            load();
          }}
        />
      ) : displayStepId === 'create-spec' ? (
        // spec-305 dec-9: copy-paste prompt + bring-your-own-PRD or sample; advances
        // the moment the agent creates the spec (hasSpec).
        <CreateSpecStep
          preview={preview}
          onComplete={load}
          onCtaClick={trackStepCta}
          onCreateInApp={() => {
            // Pure navigation to the New Spec modal (?new=1) — writes nothing, so like any
            // 'navigate' CTA it works even in operator preview. Keeps the link from being a
            // dead end when colleagues preview the card.
            if (specsPath) navigate(`${specsPath}?new=1`);
          }}
        />
      ) : displayStepId === 'resolve-decision' || displayStepId === 'add-ac' ? (
        // spec-305 dec-8: paste-a-prompt cards; advance on the step's milestone.
        <AgentPromptStep stepId={displayStepId} preview={preview} onComplete={load} onCtaClick={trackStepCta} />
      ) : displayStepId === 'see-green' ? (
        // spec-305 dec-8: the aha — watch an AC go green from a real test (acVerified).
        <SeeGreenStep preview={preview} onComplete={load} onCtaClick={trackStepCta} />
      ) : view ? (
        <JourneyStepShell view={view} userName={firstName(user?.name)} onCta={handleCta} />
      ) : (
        <div className="flex min-h-[70vh] items-center justify-center text-muted">Loading…</div>
      );
  }
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
