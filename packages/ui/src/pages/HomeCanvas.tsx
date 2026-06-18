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
import type { JourneyCta } from '../journeys/types';

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
        case 'create_decision':
        case 'open_specs':
        default:
          if (specsPath) navigate(specsPath);
          break;
      }
    },
    [activeStepId, preview, navigate, specsPath],
  );

  const view = activeStepId ? resolveStepView(activeStepId) : null;

  return (
    <div className="min-h-full" data-testid="home-canvas">
      {state?.canPreview && (
        <PreviewBar
          activeStepId={serverStepId}
          onPick={(id) => setSearchParams(id ? { preview: id } : {})}
        />
      )}
      {view ? (
        <JourneyStepShell view={view} userName={firstName(user?.name)} onCta={handleCta} />
      ) : (
        <div className="flex min-h-[70vh] items-center justify-center text-muted">Loading…</div>
      )}
    </div>
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
      title="Internal operator tool — visible only to Mindset staff (your email is on the preview allow-list). Pin any step to preview it on your own account; your real progress is unchanged, and regular users never see this bar."
      className="flex flex-wrap items-center gap-2 border-b border-dashed border-status-warning-border bg-status-warning-bg/60 px-4 py-1.5 text-xs"
    >
      <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider text-status-warning-text">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
        </svg>
        Internal preview · Mindset only
      </span>
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
        render-only · users never see this
      </span>
    </div>
  );
}
