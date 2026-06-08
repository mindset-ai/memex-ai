// spec-200 t-5 / t-6: the What's New surface.
//
// dec-4: a transient-but-sticky slide-up RIBBON (not a permanent chrome icon).
// When an undismissed entry newer than the user's last-dismissed marker exists,
// the ribbon slides up (with a full-screen confetti burst). Clicking it opens a
// popup of recent entries, newest-first. Closing the popup does NOT dismiss the
// ribbon — only the ribbon's own × does, and that dismissal persists per-user in
// localStorage (t-6). Each entry carries an ear affordance that asks Specky to
// explain it (t-7 wires onExplain).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Specky } from '../Specky';
import { Confetti } from './Confetti';
import { fetchWhatsNew, type WhatsNewEntry } from '../../api/whatsNew';

const DISMISS_KEY = 'whats-new:dismissed-at';

function readDismissedAt(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const t = raw ? Date.parse(raw) : 0;
    return Number.isNaN(t) ? 0 : t;
  } catch {
    return 0;
  }
}

function writeDismissedAt(iso: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DISMISS_KEY, iso);
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
}

export function WhatsNewRibbon({ onExplain, fetcher = fetchWhatsNew }: WhatsNewRibbonProps) {
  const [entries, setEntries] = useState<WhatsNewEntry[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [slidIn, setSlidIn] = useState(false);
  const [confetti, setConfetti] = useState(false);
  const firedConfetti = useRef(false);

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

  // Visible when there's an entry newer than the dismissed marker (t-6).
  const hasUnseen = !!newest && Date.parse(newest.publishedAt) > readDismissedAt();
  const visible = hasUnseen && !dismissed;

  // Slide the ribbon in (next tick → CSS transition) and fire confetti once.
  useEffect(() => {
    if (!visible) {
      setSlidIn(false);
      return;
    }
    const t = setTimeout(() => setSlidIn(true), 30);
    if (!firedConfetti.current && !prefersReducedMotion()) {
      firedConfetti.current = true;
      setConfetti(true);
    }
    return () => clearTimeout(t);
  }, [visible]);

  const dismiss = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (newest) writeDismissedAt(newest.publishedAt);
      setDismissed(true);
      setOpen(false);
      setConfetti(false);
    },
    [newest],
  );

  // Popup close ≠ dismiss (dec-4): the ribbon stays up.
  const closePopup = useCallback(() => setOpen(false), []);

  if (!visible) return null;

  const reduced = prefersReducedMotion();

  return (
    <>
      {confetti && <Confetti onDone={() => setConfetti(false)} />}

      {/* Slide-up ribbon */}
      <div
        data-testid="whats-new-ribbon"
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(true)}
        className="fixed left-1/2 bottom-6 z-40 flex items-center gap-3 rounded-full border border-edge bg-surface px-4 py-2.5 shadow-2xl cursor-pointer"
        style={{
          transform: `translateX(-50%) translateY(${slidIn || reduced ? '0' : '180px'})`,
          opacity: slidIn || reduced ? 1 : 0,
          transition: reduced ? 'none' : 'transform .6s cubic-bezier(.16,1,.3,1), opacity .4s',
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
          onClick={dismiss}
          className="ml-2 grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-surface-hover"
        >
          ✕
        </button>
      </div>

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
