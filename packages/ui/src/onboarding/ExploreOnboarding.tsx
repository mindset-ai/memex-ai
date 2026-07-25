// spec-508 Part 3 (dec-4 / dec-5, ac-8 / ac-9): the first-landing welcome that
// morphs into the Explore companion.
//
// A wizard-eligible user's FIRST landing over the featured demo Memex opens with a
// big centered card — the one place nobody can miss — telling them this is a real,
// live Memex set up for them to explore. One button: OK. Clicking OK (or Esc, or
// the backdrop) slides the card down and MORPHS it into the bottom-right Explore
// companion: same element, animated position/size/radius, via Motion's shared-
// layout `layoutId` (dec-4 — a librarified morph, essentially no bespoke animation
// code). The morph TEACHES where the companion lives, which directly answers the
// "users don't see the dialogue" complaint one step earlier in the funnel.
//
// The welcome and the corner companion are two states of ONE layout element
// (`layoutId={SHELL_LAYOUT_ID}`): when `dismissed` flips, the centered card
// unmounts and the corner panel mounts sharing that id, so Motion FLIP-animates
// between their bounding boxes and crossfades their contents.
//
// Persistence (spec-508 update, reversing dec-5): dismissal is IN-MEMORY only — a
// page refresh returns to the centered welcome. Clicking OK morphs to the companion
// for the rest of the session; a hard reload starts fresh at the welcome again.
//
// Reduced motion (ac-8): transitions collapse to duration 0 — the card is simply
// replaced by the companion, no slide.
//
// Accessibility: the welcome is the ONE modal-feeling beat (dimmed backdrop, role
// dialog, focus on OK) but never traps — Esc and backdrop-click behave like OK.
// After the morph, spec-502 ac-19's posture resumes untouched: a non-modal <aside>
// with the aria-live synopsis, no dialog role.
//
// This whole module (and Motion with it) is lazy-loaded by ExploreCompanionMount
// only for first-time featured-demo visitors — returning visitors render the plain
// ExploreCompanion and never pull Motion into their bundle.

import { useEffect, useRef, useState } from 'react';
import { LazyMotion, domMax, m, AnimatePresence, LayoutGroup, useReducedMotion } from 'motion/react';
import { ExploreCompanionBody } from './ExploreCompanion';
import { useTelemetry } from '../hooks/useTelemetry';

export interface ExploreOnboardingProps {
  /** Fired when the companion's "Create your own Memex" CTA is clicked. */
  readonly onCreate: () => void;
  /** The featured Memex being explored — carried on the funnel-head event. */
  readonly memexId?: string;
  /** The featured Memex's display name, woven into the welcome copy (portable —
   *  no hardcoded slug, std-22). Falls back to a generic phrase when absent. */
  readonly memexName?: string;
}

// The shared-layout id that binds the centered welcome and the corner companion
// into one morphing element. Border-radius is animated via `style` (not a Tailwind
// class) so Motion can counter-scale it and keep the corners crisp through the morph.
const SHELL_LAYOUT_ID = 'explore-companion-shell';

export function ExploreOnboarding({ onCreate, memexId, memexName }: ExploreOnboardingProps) {
  const [dismissed, setDismissed] = useState(false);
  const reduce = useReducedMotion();
  const { track } = useTelemetry(true);
  const okRef = useRef<HTMLButtonElement>(null);
  const dismissingRef = useRef(false);

  // Funnel: the welcome sits AHEAD of the companion (wizard.explore_viewed, fired
  // by the body on morph). Record the welcome view once per mount.
  const viewedRef = useRef(false);
  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    track('wizard.welcome_viewed');
  }, [track]);

  // Modal-feeling but never trapping: focus OK on open, Esc dismisses like OK.
  useEffect(() => {
    if (dismissed) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleOk();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // handleOk is stable enough for this one-shot listener; deps kept minimal on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed]);

  function handleOk(): void {
    if (dismissingRef.current) return; // guard Esc + click + backdrop racing
    dismissingRef.current = true;
    track('wizard.welcome_ok');
    setDismissed(true); // in-memory only — a refresh returns to the centered welcome
  }

  const morph = reduce
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 340, damping: 34 };
  const fade = reduce ? { duration: 0 } : { duration: 0.22 };

  return (
    <LazyMotion features={domMax} strict>
      <LayoutGroup>
        {/* Dimmed backdrop — only under the welcome; fades out as the card morphs. */}
        <AnimatePresence>
          {!dismissed && (
            <m.div
              key="explore-welcome-backdrop"
              data-testid="explore-welcome-backdrop"
              aria-hidden="true"
              onClick={handleOk}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fade}
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
            />
          )}
        </AnimatePresence>

        {!dismissed ? (
          // Centered welcome. The flex parent does the centering (no transform on
          // the layout element, so Motion owns the morph transform cleanly).
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
            <m.aside
              key="explore-welcome"
              layoutId={SHELL_LAYOUT_ID}
              transition={morph}
              style={{ borderRadius: 20 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="explore-welcome-title"
              data-testid="explore-welcome"
              className="pointer-events-auto w-[34rem] max-w-[calc(100vw-3rem)] border border-agent/40 bg-card-hover shadow-2xl shadow-agent/30 p-7 flex flex-col gap-5"
            >
              <div className="flex flex-col gap-3">
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-agent/30 bg-agent/10 px-3 py-0.5 text-xs font-semibold text-agent">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-agent" />
                  Live Memex
                </span>
                <h2
                  id="explore-welcome-title"
                  className="text-2xl font-semibold text-primary leading-tight wrap-break-word"
                >
                  This read-only Memex is set up for you
                </h2>
                <p className="text-base text-secondary leading-relaxed wrap-break-word">
                  You're in {memexName || 'a live Memex'}, the real workspace this product is
                  built in. Look around as much as you like.
                </p>
              </div>
              <div className="flex flex-col gap-2.5">
                <button
                  ref={okRef}
                  type="button"
                  onClick={handleOk}
                  data-testid="explore-welcome-ok"
                  className="flex w-full items-center justify-center rounded-lg px-4 py-3 text-base font-semibold bg-agent text-white hover:bg-agent-hover transition-colors"
                >
                  Start exploring
                </button>
              </div>
            </m.aside>
          </div>
        ) : (
          // The morph destination: the same shell, now docked bottom-right, wrapping
          // the shared companion body. No `animate-companion-in` — Motion drives the
          // entrance via the layoutId morph. Non-modal <aside>, ac-19 posture intact.
          <m.aside
            key="explore-companion"
            layoutId={SHELL_LAYOUT_ID}
            transition={morph}
            style={{ borderRadius: 12 }}
            aria-label="Explore companion"
            data-testid="explore-companion"
            className="fixed bottom-6 right-6 z-40 w-[26rem] max-w-[calc(100vw-3rem)] border border-agent/40 bg-card-hover shadow-2xl shadow-agent/25 p-5 flex flex-col gap-4"
          >
            <ExploreCompanionBody onCreate={onCreate} memexId={memexId} />
          </m.aside>
        )}
      </LayoutGroup>
    </LazyMotion>
  );
}
