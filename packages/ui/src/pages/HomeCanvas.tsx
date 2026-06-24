// spec-303 / spec-336 — the Home Canvas.
//
// spec-303 gave us the engine (dec-1): it loads the journey from the registry and the
// user's DERIVED position from the server. spec-336 (v2) changes the PRESENTATION into a
// persistent "Getting started on Memex" tracker — a flat, full-width step panel with a
// vertical RAIL that appears once the user is past step 0. The whole arc is visible at
// once; every newcomer sees it (not hidden behind an opt-in walkthrough).
//
// Two ideas are decoupled (spec-336 dec-5/dec-6):
//   • ATTAINMENT — a step's orb tick + the overall % — is DERIVED from real, user-scoped
//     milestones (getUserJourneyState). It advances ONLY on real completion, never on
//     viewing. Self-healing, never stored as a cursor (spec-303 dec-3).
//   • VIEWING — which step's content the panel shows — is a free, remembered cursor.
//     Clicking any node views it (no gating) and changes neither an orb nor the %. The
//     last-viewed step is remembered per user across visits (localStorage). No restart.
//
// The journey is BRANCHED by persona, entirely UI-side (spec-336 dec-3): builder-leaning
// roles + the full-stack generalist see all six steps; non-builders skip the two "Build
// from your codebase" steps and end at "Done becomes a fact" with a handoff message.
//
// Collapse is an in-place chevron toggle of the tracker content (spec-336, revised
// 2026-06-23 to match the prototype — NOT the spec-312 collapse-to-pearls seam). The
// header (title + progress + chevron) stays; the rail + panel hide/show beneath it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { useUserChangeStream } from '../hooks/useUserChangeStream';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  fetchJourneyStateApi,
  postJourneyEventApi,
  type JourneyStateResponse,
  type RoleCoords,
} from '../api/journey';
import { resolveStepView, activeJourney } from '../journeys/registry';
import { BUILDER_ONLY_STEP_IDS } from '../journeys/onboarding/steps';
import { isJourneyGraduated } from '../journeys/graduation';
import { YourJourneys, type PearlJourney } from '../components/home/YourJourneys';
import { HomeValue } from '../components/home/HomeValue';
import { JourneyStepShell } from '../components/home/JourneyStepShell';
import { IdentityStep } from '../components/home/IdentityStep';
import { CreateSpecStep } from '../components/home/CreateSpecStep';
import { AgentPromptStep } from '../components/home/AgentPromptStep';
import { SpecsMatchRealityStep } from '../components/home/SpecsMatchRealityStep';
import { AgentsBuildStep } from '../components/home/AgentsBuildStep';
import { personaLabel } from '../components/home/RoleTriangle';
import type { JourneyCta, JourneyStepView } from '../journeys/types';

type NavMembership = { slug: string; memexSlug?: string | null; kind: string };

// The first step is rendered full-width with no rail (spec-336 / prototype: the rail
// reveals once the user is past "About you").
const FIRST_STEP_ID = 'identity';

function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const f = name.trim().split(/\s+/)[0];
  return f || null;
}

function personalSpecsPath(memberships?: ReadonlyArray<NavMembership>): string | null {
  if (!memberships || memberships.length === 0) return null;
  const personal = memberships.find((m) => m.kind === 'personal') ?? memberships[0];
  const ns = personal.slug;
  const mx = personal.memexSlug ?? (personal.kind === 'personal' ? 'personal' : 'main');
  return `/${ns}/${mx}/specs`;
}

// spec-336 dec-3: builder-ness derived from the captured role placement via the SHARED
// personaLabel helper. A builder = the persona label names a builder ("builder"), is the
// full-stack generalist, or is the strong-dev "Deep in the code" lean (the one dev-family
// label personaLabel emits without the word "builder"). Non-placed (null) defaults to
// builder so a brand-new user sees the full arc until they place themselves on step 0.
function isBuilderPersona(coords: RoleCoords | null): boolean {
  if (!coords) return true;
  const label = personaLabel(coords).toLowerCase();
  return label.includes('builder') || label.includes('generalist') || label === 'deep in the code';
}

function cursorStorageKey(userId: string | null | undefined): string | null {
  return userId ? `memex:onboarding:viewing:${userId}` : null;
}
function readStoredCursor(userId: string | null | undefined): string | null {
  const key = cursorStorageKey(userId);
  if (!key || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStoredCursor(userId: string | null | undefined, stepId: string): void {
  const key = cursorStorageKey(userId);
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, stepId);
  } catch {
    /* private mode / quota — viewing memory is best-effort */
  }
}

const HANDOFF_MESSAGE =
  "This is now a spec as far as you can take it — it's time to hand it off to a human or a coding agent to ground the spec in the codebase and pursue it to a build.";

export function HomeCanvas() {
  const { user, session } = useAuth();
  const navigate = useNavigate();
  // The operator step-switcher UI (PreviewBar) was removed in spec-344, but the
  // `?preview=<step>` debug capability is retained: staff can still preview any step by
  // visiting /home?preview=<step> (server-gated by canPreview). So we still READ the param,
  // we just no longer write it from any in-page control.
  const [searchParams] = useSearchParams();
  const previewParam = searchParams.get('preview');

  useDocumentTitle({ kind: 'page', title: 'Home' });

  const [state, setState] = useState<JourneyStateResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [restored, setRestored] = useState(false);
  // Two collapse concepts coexist:
  //  • The spec-312 graduation seam still governs whether the journey LAYER shows at all:
  //    once every visible step is attained the layer recedes to the "Your Journeys" pearls,
  //    which re-open it (forceShow). (spec-312 ac-12/ac-19, spec-315 — preserved.)
  //  • Within a shown layer, the chevron is a spec-336 in-place toggle (revised 2026-06-23
  //    to match the prototype): it hides the rail + panel beneath the header, no pearls.
  const [forceShow, setForceShow] = useState(false);
  const [contentCollapsed, setContentCollapsed] = useState(false);

  const load = useCallback(() => {
    fetchJourneyStateApi(previewParam)
      .then(setState)
      .catch(() => {
        /* keep last good state — the canvas never hard-crashes on a fetch blip */
      });
  }, [previewParam]);

  // A step's milestone was just met (the user completed the step they're viewing). Drop
  // any viewing pin and refetch so the canvas follows the server to the next step — even
  // if the user was pinned to the now-completed step (otherwise the pin would strand them
  // on a done step and the advance would be invisible).
  const handleStepComplete = useCallback(() => {
    setPinned(false);
    setCursor(null);
    load();
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  useUserChangeStream(load, ['document', 'decision']);
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const preview = state?.preview ?? false;
  const serverStepId = state?.currentStepId ?? null;
  const journey = activeJourney();

  const builder = isBuilderPersona(state?.roleCoords ?? null);
  const visibleSteps = useMemo(() => {
    const all = state?.steps ?? [];
    return builder ? all : all.filter((s) => !(BUILDER_ONLY_STEP_IDS as readonly string[]).includes(s.id));
  }, [state, builder]);
  const visibleIds = useMemo(() => visibleSteps.map((s) => s.id), [visibleSteps]);

  const clampToVisible = useCallback(
    (id: string | null): string | null => {
      if (id && visibleIds.includes(id)) return id;
      return visibleIds.length ? visibleIds[visibleIds.length - 1] : id;
    },
    [visibleIds],
  );

  useEffect(() => {
    if (restored || !state || preview) return;
    const stored = readStoredCursor(user?.id);
    // Restore the remembered cursor — but ONLY if it's a visible step the user hasn't
    // yet completed. Pinning to an already-attained step (one the server has advanced
    // past) would trap a returning user on a done step; in that case we follow the live
    // current step instead (spec-336 ac-15: remember where you left off, don't strand you).
    const storedStep = stored ? state.steps.find((s) => s.id === stored) : undefined;
    if (stored && visibleIds.includes(stored) && storedStep && !storedStep.attained) {
      setCursor(stored);
      setPinned(stored !== serverStepId);
    }
    setRestored(true);
  }, [restored, state, preview, visibleIds, serverStepId, user?.id]);

  const displayStepId = preview
    ? serverStepId
    : pinned && cursor && visibleIds.includes(cursor)
      ? cursor
      : clampToVisible(serverStepId);

  useEffect(() => {
    if (preview || !displayStepId) return;
    writeStoredCursor(user?.id, displayStepId);
  }, [displayStepId, preview, user?.id]);

  useEffect(() => {
    if (displayStepId && !preview && journey.milestoneStepIds.includes(displayStepId)) {
      postJourneyEventApi(displayStepId, 'shown');
    }
  }, [displayStepId, preview, journey]);

  const specsPath = useMemo(
    () => personalSpecsPath(session?.memberships as ReadonlyArray<NavMembership> | undefined),
    [session],
  );

  const selectStep = useCallback(
    (id: string) => {
      if (id === serverStepId) {
        setPinned(false);
        setCursor(null);
      } else {
        setPinned(true);
        setCursor(id);
      }
    },
    [serverStepId],
  );

  const trackStepCta = useCallback(
    (target: string) => {
      if (displayStepId && !preview && journey.milestoneStepIds.includes(displayStepId)) {
        postJourneyEventApi(displayStepId, 'cta', target);
      }
    },
    [displayStepId, preview, journey],
  );

  const handleCta = useCallback(
    (cta: JourneyCta) => {
      if (displayStepId && !preview && journey.milestoneStepIds.includes(displayStepId)) {
        postJourneyEventApi(displayStepId, 'cta', cta.target);
      }
      if (cta.kind === 'navigate') {
        selectStep(cta.target);
        return;
      }
      if (preview) return;
      if (cta.kind === 'link') {
        window.open(cta.target, '_blank', 'noopener,noreferrer');
        return;
      }
      // action — route into the real in-app flow (spec-305 dec-5). No 'invite' action:
      // the invite-colleagues modal is dropped in v2 (spec-336 dec-7 / ac-17).
      switch (cta.target) {
        case 'create_spec':
          if (specsPath) navigate(`${specsPath}?new=1`);
          break;
        case 'create_decision':
        case 'open_specs':
        default:
          if (specsPath) navigate(specsPath);
          break;
      }
    },
    [displayStepId, preview, journey, selectStep, navigate, specsPath],
  );

  // Progress (spec-336 ac-14 / dec-6): % over the steps VISIBLE to this user, derived from
  // real attainment only — never from viewing.
  const attainedCount = visibleSteps.filter((s) => s.attained).length;
  const pct = visibleSteps.length ? Math.round((attainedCount / visibleSteps.length) * 100) : 0;

  const pearlJourneys: PearlJourney[] = useMemo(() => {
    if (!visibleSteps.length) return [];
    return [
      {
        id: journey.id,
        title: 'Getting started',
        steps: visibleSteps.map((s) => ({
          id: s.id,
          label: journey.views[s.id]?.mapLabel ?? s.id,
          attained: s.attained,
        })),
      },
    ];
  }, [visibleSteps, journey]);

  const nonBuilderTerminal =
    !builder && displayStepId === visibleIds[visibleIds.length - 1] && displayStepId === 'add-ac';

  // The journey layer recedes to the pearls once graduated (spec-312), unless re-opened.
  const graduated = isJourneyGraduated(state ? { ...state, steps: visibleSteps } : null);
  const layerVisible = !!state?.steps?.length && (!graduated || forceShow);

  // The rail reveals once the user is past the first step (prototype: full-width step 0),
  // and only while the content isn't collapsed in place.
  const showRail =
    !contentCollapsed && !!displayStepId && displayStepId !== FIRST_STEP_ID && visibleSteps.length > 0;

  return (
    <div className="font-onboarding min-h-full" data-testid="home-canvas">
      {/* spec-336 / prototype: the page-level Home header above the tracker. */}
      <div className="mx-auto max-w-5xl px-4 pt-10 sm:px-6">
        <h1 data-testid="home-page-title" className="text-4xl font-black tracking-tight text-heading">
          Home
        </h1>
        <p className="mt-2 text-lg text-secondary">
          Keep updated with the things that need your attention across all your Personal and Organisational Memex&apos;s
        </p>
      </div>

      {layerVisible ? (
        <section data-testid="journey-layer" className="relative">
          <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
            {/* Header — click anywhere to collapse/expand the tracker content in place. */}
            <div
              role="button"
              tabIndex={0}
              aria-expanded={!contentCollapsed}
              onClick={() => setContentCollapsed((c) => !c)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setContentCollapsed((c) => !c);
                }
              }}
              className="flex cursor-pointer select-none flex-wrap items-center gap-3 rounded-xl border-b border-edge px-2 pb-4 pt-1 transition hover:bg-card-hover/50"
            >
              <h2 data-testid="getting-started-title" className="whitespace-nowrap text-lg font-bold text-accent">
                Getting started on Memex
              </h2>
              <div className="ml-auto flex items-center gap-3">
                <div
                  data-testid="journey-progress-bar"
                  className="h-2 w-40 overflow-hidden rounded-full bg-edge sm:w-64"
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span data-testid="journey-progress" className="whitespace-nowrap text-xs font-semibold text-secondary">
                  {pct}% complete
                </span>
                <span
                  data-testid="journey-collapse"
                  aria-hidden
                  className="flex h-7 w-7 items-center justify-center text-muted"
                >
                  <svg
                    className="h-4 w-4 transition-transform duration-300"
                    style={{ transform: contentCollapsed ? 'rotate(0deg)' : 'rotate(180deg)' }}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </span>
              </div>
            </div>

            {!contentCollapsed && (
              <div className="mt-6 flex flex-col gap-8 md:flex-row">
                {showRail && (
                  <JourneyRail
                    steps={visibleSteps}
                    serverStepId={serverStepId}
                    selectedStepId={displayStepId}
                    views={journey.views}
                    onSelect={selectStep}
                  />
                )}
                <div className="min-w-0 flex-1 pt-1" data-testid="journey-content">
                  {renderJourneyStep()}
                  {nonBuilderTerminal && (
                    <div
                      data-testid="nonbuilder-handoff"
                      className="mt-8 max-w-2xl rounded-2xl border border-edge bg-surface/60 p-6 text-secondary"
                    >
                      {HANDOFF_MESSAGE}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      ) : null}

      <HomeValue specsPath={specsPath} />

      {/* spec-312/315: the journey pearls — the static bottom surface + the re-entry point
          for a graduated (receded) journey. Clicking re-opens the layer. */}
      <YourJourneys
        journeys={pearlJourneys}
        onOpen={() => {
          setForceShow(true);
          setContentCollapsed(false);
        }}
      />
    </div>
  );

  function renderJourneyStep() {
    const view = displayStepId ? resolveStepView(displayStepId) : null;
    switch (displayStepId) {
      case 'identity':
        return <IdentityStep preview={preview} onComplete={handleStepComplete} onCtaClick={trackStepCta} />;
      case 'create-spec':
        return (
          <CreateSpecStep
            preview={preview}
            onComplete={handleStepComplete}
            onCtaClick={trackStepCta}
            onCreateInApp={() => {
              if (specsPath) navigate(`${specsPath}?new=1`);
            }}
          />
        );
      case 'resolve-decision':
      case 'add-ac':
        return (
          <AgentPromptStep stepId={displayStepId} preview={preview} onComplete={handleStepComplete} onCtaClick={trackStepCta} />
        );
      case 'specs-match-reality':
        return <SpecsMatchRealityStep preview={preview} onComplete={handleStepComplete} onCtaClick={trackStepCta} />;
      case 'agents-build':
        return <AgentsBuildStep onCtaClick={trackStepCta} />;
      default:
        return view ? (
          <JourneyStepShell view={view} userName={firstName(user?.name)} onCta={handleCta} />
        ) : (
          <div className="flex min-h-[40vh] items-center justify-center text-muted">Loading…</div>
        );
    }
  }
}

// spec-336 — the persistent vertical rail. Every visible step is a node: orb state from
// REAL attainment, title (the step's headline) + sub from the journey views. The selected
// node (the one in the panel) is highlighted; clicking a node views it (free navigation).
// A divider labels the builder-only "Build from your codebase" stretch.
function JourneyRail({
  steps,
  serverStepId,
  selectedStepId,
  views,
  onSelect,
}: {
  steps: { id: string; attained: boolean }[];
  serverStepId: string | null;
  selectedStepId: string | null;
  views: Record<string, JourneyStepView>;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      data-testid="journey-rail"
      aria-label="Getting started steps"
      className="w-full flex-none animate-[fadeIn_0.4s_ease] md:w-64"
    >
      <ol className="flex flex-col gap-0.5">
        {steps.map((s) => {
          const view = views[s.id];
          const isSelected = s.id === selectedStepId;
          const isCurrent = s.id === serverStepId;
          const showDivider = s.id === 'specs-match-reality';
          return (
            <li key={s.id}>
              {showDivider && (
                <div
                  data-testid="rail-divider-build"
                  className="mb-1 mt-3 px-3.5 text-[13px] font-bold tracking-wide text-secondary"
                >
                  Build from your codebase
                </div>
              )}
              <button
                type="button"
                data-testid={`journey-rail-node-${s.id}`}
                data-attained={s.attained ? 'true' : 'false'}
                data-selected={isSelected ? 'true' : 'false'}
                aria-current={isSelected ? 'step' : undefined}
                onClick={() => onSelect(s.id)}
                className={`flex w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left transition ${
                  isSelected ? 'bg-accent/10' : 'hover:bg-card-hover/60'
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border-2 text-xs font-bold transition ${
                    s.attained
                      ? 'border-accent bg-accent text-white'
                      : isSelected || isCurrent
                        ? 'border-accent bg-accent/10 text-accent ring-4 ring-accent/15'
                        : 'border-edge text-muted'
                  }`}
                >
                  {s.attained ? '✓' : ''}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-base font-semibold ${
                      isSelected ? 'text-heading' : s.attained ? 'text-secondary' : 'text-primary'
                    }`}
                  >
                    {view?.mapLabel ?? s.id}
                  </span>
                  {view?.mapSubLabel && (
                    <span className="mt-0.5 block text-[13.5px] leading-snug text-muted">{view.mapSubLabel}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// spec-344: the operator-only PreviewBar (a yellow "manual step switcher" banner, spec-303
// dec-9) and its JourneyInfo tooltip were removed — staff Home now looks like everyone's.
// The `?preview=<step>` debug capability is retained via the URL (see previewParam above).
