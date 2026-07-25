// spec-502 t-4 (dec-7, ac-16/17/19): the context-aware Explore companion.
//
// A floating panel that overlays the read-only `building-itself` Explore view
// (wizard step 0). It is the home of the standing "Create your own Memex" CTA and,
// crucially, it is CONTEXT-AWARE rather than a click-next tour: as the user
// navigates the Memex, `useExploreContext()` re-derives the in-view entity from the
// route and the panel re-renders a short synopsis of whatever they are looking at
// (ac-16, ac-17). The user drives; the companion narrates.
//
// Accessibility (ac-19): the synopsis is live text in an aria-live="polite" region
// so it is announced on change; the panel is a plain <aside>, NOT a focus-trapping
// modal (no role="dialog", no focus lock); and the "Create your own Memex" CTA is
// always present and actionable through every context change.
//
// spec-508 Part 3: the panel body is extracted into `ExploreCompanionBody` so the
// first-run welcome→companion morph (ExploreOnboarding) can reuse the exact same
// content as its Motion morph target — the corner panel is one body, two shells
// (this plain <aside> for returning visitors, a motion shell for the morph).

import { useEffect, useRef } from 'react';
import { useExploreContext } from './useExploreContext';
import { deriveSynopsis } from './synopsis';
import { useTelemetry } from '../hooks/useTelemetry';

export interface ExploreCompanionProps {
  /** Fired when the user clicks "Create your own Memex" — opens the wizard. */
  readonly onCreate: () => void;
  /** The featured Memex being explored — carried on the funnel-head event. */
  readonly memexId?: string;
  /** Optional extra classes for positioning in a host layout. */
  readonly className?: string;
}

/** The panel's inner content — the "you're exploring" pill, the live-region
 *  synopsis, and the standing CTA. Shared verbatim between the plain-aside
 *  companion and the morph target so the two can never drift (spec-508). It owns
 *  the `wizard.explore_viewed` funnel head so step 0 is recorded on either path. */
export function ExploreCompanionBody({ onCreate, memexId }: Omit<ExploreCompanionProps, 'className'>) {
  const entity = useExploreContext();
  const synopsis = deriveSynopsis(entity);
  const { track } = useTelemetry(true);

  // Funnel head (std-35, ac-10): the companion appearing over the demo IS step 0.
  // Fire once per mount — advisory, no-ops without a resolved tenant.
  const viewedRef = useRef(false);
  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    track('wizard.explore_viewed', memexId ? { memexId } : undefined);
  }, [track, memexId]);

  function handleCreate() {
    track('wizard.create_cta_clicked');
    onCreate();
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        {/* Header: a "you're exploring" kicker on the left, and a live-status
            pill on the right. The pill (not inline prose) owns the framing —
            this is a real, live Memex, not a demo and not the user's own
            workspace — so it reads cleanly instead of wrapping mid-sentence.
            The accent is the violet `agent` token, kept off blue on purpose. */}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted">
            <span aria-hidden="true">🔍</span>
            You're exploring
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-agent/30 bg-agent/10 px-2.5 py-0.5 text-xs font-semibold text-agent">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-agent" />
            Live Memex
          </span>
        </div>
        {/* Live region: the synopsis is re-announced whenever the in-view entity
            changes as the user clicks around (ac-17 + ac-19). The headline is
            the emphasis of the panel — it's whatever they're looking at now. */}
        <div aria-live="polite" data-testid="explore-companion-synopsis">
          <h3 className="text-lg font-semibold text-primary wrap-break-word leading-snug">
            {synopsis.headline}
          </h3>
          <p className="mt-1.5 text-sm text-secondary wrap-break-word leading-snug">
            {synopsis.body}
          </p>
        </div>
      </div>

      {/* The standing CTA — always present, regardless of what the user is
          viewing. This is the only forward action out of step 0. The screen-
          specific nudge above it ("you could have this too") gives the generic
          button a concrete, context-tied reason to click. */}
      <div className="flex flex-col gap-3 border-t border-edge pt-4">
        <p
          className="text-sm text-secondary wrap-break-word leading-snug"
          data-testid="explore-companion-nudge"
        >
          {synopsis.nudge}
        </p>
        <button
          type="button"
          onClick={handleCreate}
          data-testid="create-your-own-memex-cta"
          className="group flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-base font-semibold bg-agent text-white hover:bg-agent-hover transition-colors"
        >
          <span>Create your own Memex</span>
          <span
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5"
          >
            →
          </span>
        </button>
        <p className="text-center text-xs text-muted">Free · connect your coding agent · ~2 min</p>
      </div>
    </>
  );
}

/** The companion at rest — a plain, non-modal <aside> docked bottom-right with the
 *  CSS `animate-companion-in` entrance. This is the returning-visitor path (the
 *  welcome has already been dismissed); the first-run path renders the same body
 *  inside ExploreOnboarding's Motion morph target instead. */
export function ExploreCompanion({ onCreate, memexId, className }: ExploreCompanionProps) {
  return (
    <aside
      aria-label="Explore companion"
      data-testid="explore-companion"
      className={
        'fixed bottom-6 right-6 z-40 w-[26rem] max-w-[calc(100vw-3rem)] rounded-xl border ' +
        'border-agent/40 bg-card-hover shadow-2xl shadow-agent/25 p-5 flex flex-col gap-4 ' +
        'animate-companion-in' +
        (className ? ` ${className}` : '')
      }
    >
      <ExploreCompanionBody onCreate={onCreate} memexId={memexId} />
    </aside>
  );
}
