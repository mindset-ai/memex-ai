// spec-200 t-5 / t-6 (+ follow-up behaviour pass): the What's New surface.
//
// dec-4: a transient-but-sticky slide-up RIBBON (not a permanent chrome icon).
// When an undismissed entry newer than the user's last-dismissed marker exists,
// the ribbon slides up. Clicking it opens a popup of recent entries, newest-first.
// Each entry carries an ear affordance that asks Specky to explain it (t-7).
//
// Follow-up behaviour changes (2026-06-13), per the originator:
//  1. Confetti fires only the FIRST time a given entry is seen (a localStorage
//     marker, separate from dismissal) — a repeat visit shows the ribbon without
//     confetti.
//  2. The ribbon auto-dismisses after 6s, with a bottom border that depletes
//     right→left as a countdown. Tapping the ribbon (opens the popup) or the ×
//     both stop the countdown immediately.
//  3. On dismiss (manual, auto, or popup-close) the ribbon animates "into" the
//     user menu in the lower-left (translate + fade) — the menu does NOT open.
//     This reads the menu anchor from WhatsNewContext.
//  4. The popup can be re-opened from the sidebar "What's New" menu item even
//     after the ribbon is gone (via WhatsNewContext.openPopup).
//  5. Manually closing the popup dismisses the ribbon (fly-home), superseding the
//     earlier dec-4 "popup close ≠ dismiss" rule.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Specky } from '@memex/guide-sdk';
import { Confetti } from './Confetti';
import { useWhatsNew } from './WhatsNewContext';
import { fetchWhatsNew, type WhatsNewEntry } from '../../api/whatsNew';

const DISMISS_KEY = 'whats-new:dismissed-at';
const CONFETTI_KEY = 'whats-new:confetti-shown-at';

/** Auto-dismiss countdown (ms) and the fly-home animation duration (ms). */
const AUTO_DISMISS_MS = 6000;
const FLY_MS = 600;

function readMarker(key: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(key);
    const t = raw ? Date.parse(raw) : 0;
    return Number.isNaN(t) ? 0 : t;
  } catch {
    return 0;
  }
}

function writeMarker(key: string, iso: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, iso);
  } catch {
    /* private mode — non-fatal */
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface WhatsNewRibbonProps {
  /** t-7: ask Specky to explain an entry. */
  onExplain?: (entry: WhatsNewEntry) => void;
  /** Injected for tests; defaults to the real GET /api/whats-new. */
  fetcher?: () => Promise<WhatsNewEntry[]>;
  /** Auto-dismiss countdown in ms; 0 disables it (tests). Default 6000. */
  autoDismissMs?: number;
}

export function WhatsNewRibbon({
  onExplain,
  fetcher = fetchWhatsNew,
  autoDismissMs = AUTO_DISMISS_MS,
}: WhatsNewRibbonProps) {
  const { setAvailable, registerOpener, getMenuAnchor } = useWhatsNew();

  const [entries, setEntries] = useState<WhatsNewEntry[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [slidIn, setSlidIn] = useState(false);
  const [confetti, setConfetti] = useState(false);
  // Countdown: `barRunning` flips on after mount to drive the width transition.
  const [countingDown, setCountingDown] = useState(false);
  const [barRunning, setBarRunning] = useState(false);
  // Fly-home dismiss animation.
  const [flying, setFlying] = useState(false);
  const [flyDelta, setFlyDelta] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const ribbonRef = useRef<HTMLDivElement>(null);
  const dismissingRef = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>();
  const flyTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let alive = true;
    fetcher()
      .then((e) => alive && setEntries(e))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [fetcher]);

  // Newest entry (the feed is newest-first, but don't assume — compute it).
  const newest = useMemo(
    () =>
      entries.reduce<WhatsNewEntry | null>(
        (acc, e) => (!acc || Date.parse(e.publishedAt) > Date.parse(acc.publishedAt) ? e : acc),
        null,
      ),
    [entries],
  );

  // The ribbon is "present" when there's an entry newer than the dismissed marker
  // and the user hasn't dismissed it this session (t-6). Popup visibility is
  // independent — it can be re-opened from the menu after dismissal.
  const ribbonPresent = !!newest && Date.parse(newest.publishedAt) > readMarker(DISMISS_KEY) && !dismissed;

  // Report feed availability to the sidebar menu item.
  useEffect(() => {
    setAvailable(entries.length > 0);
  }, [entries.length, setAvailable]);

  // Register the menu opener so the sidebar "What's New" item can open the popup.
  useEffect(() => {
    registerOpener(() => setOpen(true));
    return () => registerOpener(null);
  }, [registerOpener]);

  // Slide the ribbon in, and fire confetti only the first time THIS entry is seen
  // (req 1/2): a marker distinct from dismissal, so a repeat visit gets no confetti.
  useEffect(() => {
    if (!ribbonPresent || flying) {
      setSlidIn(false);
      return;
    }
    const t = setTimeout(() => setSlidIn(true), 30);
    if (newest && !prefersReducedMotion()) {
      const firstSighting = Date.parse(newest.publishedAt) > readMarker(CONFETTI_KEY);
      if (firstSighting) {
        writeMarker(CONFETTI_KEY, newest.publishedAt);
        setConfetti(true);
      }
    }
    return () => clearTimeout(t);
  }, [ribbonPresent, flying, newest]);

  const finalizeDismiss = useCallback(() => {
    if (newest) writeMarker(DISMISS_KEY, newest.publishedAt);
    setDismissed(true);
    setOpen(false);
    setConfetti(false);
    setFlying(false);
    setCountingDown(false);
  }, [newest]);

  // Dismiss the ribbon by animating it "into" the sidebar user menu (req 3/4),
  // then finalize. Reduced motion or a missing anchor → finalize immediately.
  const beginDismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    clearTimeout(dismissTimer.current);
    setCountingDown(false);

    const ribbonEl = ribbonRef.current;
    const anchor = getMenuAnchor();
    const a = anchor?.getBoundingClientRect();
    // No anchor, a collapsed/hidden menu (zero-size rect), or reduced motion →
    // skip the fly-home animation and just dismiss.
    if (prefersReducedMotion() || !ribbonEl || !a || (a.width === 0 && a.height === 0)) {
      finalizeDismiss();
      return;
    }
    const r = ribbonEl.getBoundingClientRect();
    setFlyDelta({
      dx: a.left + a.width / 2 - (r.left + r.width / 2),
      dy: a.top + a.height / 2 - (r.top + r.height / 2),
    });
    setFlying(true);
    flyTimer.current = setTimeout(finalizeDismiss, FLY_MS);
  }, [finalizeDismiss, getMenuAnchor]);

  // Tapping the ribbon opens the popup AND stops the countdown (req 3).
  const openFromRibbon = useCallback(() => {
    clearTimeout(dismissTimer.current);
    setCountingDown(false);
    setOpen(true);
  }, []);

  // Manually closing the popup dismisses the ribbon — the popup disappears, then
  // the ribbon flies home (req 5/6). If the ribbon is already gone (opened from
  // the menu), closing just closes.
  const closePopup = useCallback(() => {
    setOpen(false);
    if (ribbonPresent && !dismissingRef.current) {
      setTimeout(() => beginDismiss(), 30);
    }
  }, [ribbonPresent, beginDismiss]);

  // The × dismisses immediately (stops the countdown, flies home).
  const dismissNow = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      beginDismiss();
    },
    [beginDismiss],
  );

  // Run the 6s auto-dismiss countdown while the ribbon is up and the popup is
  // closed. Opening the popup (or flying) stops it. Reaching zero flies home.
  useEffect(() => {
    const shouldRun = ribbonPresent && !flying && !open && autoDismissMs > 0;
    if (!shouldRun) {
      setCountingDown(false);
      setBarRunning(false);
      clearTimeout(dismissTimer.current);
      return;
    }
    setCountingDown(true);
    setBarRunning(false);
    const barT = setTimeout(() => setBarRunning(true), 30); // kick the width transition
    dismissTimer.current = setTimeout(() => beginDismiss(), autoDismissMs);
    return () => {
      clearTimeout(barT);
      clearTimeout(dismissTimer.current);
    };
  }, [ribbonPresent, flying, open, autoDismissMs, beginDismiss]);

  // Clear the fly timer on unmount.
  useEffect(() => () => clearTimeout(flyTimer.current), []);

  if (entries.length === 0) return null;

  const reduced = prefersReducedMotion();
  const showRibbon = ribbonPresent || flying;

  const ribbonTransform = flying
    ? `translateX(-50%) translate(${flyDelta.dx}px, ${flyDelta.dy}px) scale(.25)`
    : `translateX(-50%) translateY(${slidIn || reduced ? '0' : '180px'})`;
  const ribbonOpacity = flying ? 0 : slidIn || reduced ? 1 : 0;
  const ribbonTransition = flying
    ? `transform ${FLY_MS}ms cubic-bezier(.4,0,.2,1), opacity ${FLY_MS}ms ease`
    : reduced
      ? 'none'
      : 'transform .6s cubic-bezier(.16,1,.3,1), opacity .4s';

  return (
    <>
      {confetti && <Confetti onDone={() => setConfetti(false)} />}

      {/* Slide-up ribbon */}
      {showRibbon && (
        <div
          ref={ribbonRef}
          data-testid="whats-new-ribbon"
          role="button"
          tabIndex={0}
          onClick={openFromRibbon}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openFromRibbon()}
          className="fixed left-1/2 bottom-6 z-40 flex items-center gap-3 rounded-full border border-edge bg-surface px-4 py-2.5 shadow-2xl cursor-pointer"
          style={{
            transform: ribbonTransform,
            opacity: ribbonOpacity,
            transition: ribbonTransition,
            pointerEvents: flying ? 'none' : undefined,
          }}
        >
          <span className="text-xl" aria-hidden="true">🎁</span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">What's New</div>
            <div className="text-xs text-muted">
              {entries.length} update{entries.length === 1 ? '' : 's'} shipped
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss What's New"
            data-testid="whats-new-ribbon-dismiss"
            onClick={dismissNow}
            className="ml-2 grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-surface-hover"
          >
            ✕
          </button>

          {/* Auto-dismiss countdown — an inset progress line along the ribbon's
              lower edge that depletes right→left (req 3). Inset so the pill's
              rounded corners don't clip it. Hidden once the countdown stops
              (tap / × / fly). */}
          {countingDown && !flying && (
            <div className="pointer-events-none absolute bottom-1.5 left-4 right-4 h-[2px] overflow-hidden rounded-full">
              <div
                data-testid="whats-new-countdown"
                aria-hidden="true"
                className="h-full w-full origin-left rounded-full bg-accent"
                style={{
                  transform: barRunning ? 'scaleX(0)' : 'scaleX(1)',
                  transition: `transform ${autoDismissMs}ms linear`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Popup */}
      {open && (
        <>
          <div
            data-testid="whats-new-scrim"
            onClick={closePopup}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-label="What's New"
            data-testid="whats-new-popup"
            className="fixed left-1/2 top-1/2 z-50 flex max-h-[82vh] w-[min(620px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl"
          >
            <header className="flex items-center gap-3 border-b border-edge px-5 py-4">
              <span className="text-2xl" aria-hidden="true">🎁</span>
              <div className="flex-1">
                <h2 className="text-lg font-semibold">What's New</h2>
                <p className="text-xs text-muted">What shipped — and why it matters to you</p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={closePopup}
                className="grid h-8 w-8 place-items-center rounded-lg border border-edge text-muted hover:bg-surface-hover"
              >
                ✕
              </button>
            </header>

            <div className="overflow-y-auto px-5 py-2">
              {entries.length === 0 && (
                <p className="py-8 text-center text-sm text-muted">Nothing new yet.</p>
              )}
              {entries.map((e) => (
                <article
                  key={e.id}
                  data-guide-id={`whats-new-entry-${e.sourceSpecHandle}`}
                  className="border-b border-edge py-4 last:border-b-0"
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                      {e.sourceSpecHandle}
                    </span>
                  </div>
                  <h3 className="mb-2 text-sm font-semibold">{e.title}</h3>
                  <p className="mb-1 text-sm">
                    <span className="mr-2 text-[10px] uppercase tracking-wide text-muted">What</span>
                    {e.what}
                  </p>
                  <p className="text-sm">
                    <span className="mr-2 text-[10px] uppercase tracking-wide text-muted">Why</span>
                    {e.why}
                  </p>
                  {onExplain && (
                    <button
                      type="button"
                      data-testid={`whats-new-ear-${e.sourceSpecHandle}`}
                      onClick={() => onExplain(e)}
                      className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs text-accent hover:bg-accent/20"
                    >
                      <Specky size={16} alt="" animated={false} />
                      Ask Specky to explain
                    </button>
                  )}
                </article>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
