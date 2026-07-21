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

export function ExploreCompanion({ onCreate, memexId, className }: ExploreCompanionProps) {
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
    <aside
      aria-label="Explore companion"
      data-testid="explore-companion"
      className={
        'fixed bottom-6 right-6 z-40 w-80 max-w-[calc(100vw-3rem)] rounded-xl border ' +
        'border-edge bg-card-hover shadow-xl p-4 flex flex-col gap-3' +
        (className ? ` ${className}` : '')
      }
    >
      <div className="flex flex-col gap-2.5">
        {/* Header: a "you're exploring" kicker on the left, and a live-status
            pill on the right. The pill (not inline prose) owns the framing —
            this is a real, live Memex, not a demo and not the user's own
            workspace — so it reads cleanly instead of wrapping mid-sentence.
            The accent is the violet `agent` token, kept off blue on purpose. */}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
            <span aria-hidden="true">🔍</span>
            You're exploring
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-agent/30 bg-agent/10 px-2 py-0.5 text-[11px] font-semibold text-agent">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-agent" />
            Live Memex
          </span>
        </div>
        {/* Live region: the synopsis is re-announced whenever the in-view entity
            changes as the user clicks around (ac-17 + ac-19). The headline is
            the emphasis of the panel — it's whatever they're looking at now. */}
        <div aria-live="polite" data-testid="explore-companion-synopsis">
          <h3 className="text-base font-semibold text-primary wrap-break-word leading-snug">
            {synopsis.headline}
          </h3>
          <p className="mt-1 text-xs text-secondary wrap-break-word leading-snug">
            {synopsis.body}
          </p>
        </div>
      </div>

      {/* The standing CTA — always present, regardless of what the user is
          viewing. This is the only forward action out of step 0. The screen-
          specific nudge above it ("you could have this too") gives the generic
          button a concrete, context-tied reason to click. */}
      <div className="flex flex-col gap-2.5 border-t border-edge pt-3">
        <p
          className="text-xs text-secondary wrap-break-word leading-snug"
          data-testid="explore-companion-nudge"
        >
          {synopsis.nudge}
        </p>
        <button
          type="button"
          onClick={handleCreate}
          data-testid="create-your-own-memex-cta"
          className="group flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-semibold bg-agent text-white hover:bg-agent-hover transition-colors"
        >
          <span>Create your own Memex</span>
          <span
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5"
          >
            →
          </span>
        </button>
        <p className="text-center text-[11px] text-muted">Free · connect your coding agent · ~2 min</p>
      </div>
    </aside>
  );
}
