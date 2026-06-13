// spec-200 t-5 / t-6 (+ 2026-06-13 behaviour pass) — the What's New ribbon.
//
// ac-11 — ribbon renders when an undismissed entry exists; click opens the popup
//         (entries newest-first, What/Why shown). Confetti fires on FIRST sighting.
// ac-12 — the ribbon × dismisses and the dismissal persists per-user (localStorage);
//         a newer entry re-shows the ribbon.
//
// Follow-up behaviour (this pass):
//  • confetti fires only the first time an entry is seen — a repeat visit shows the
//    ribbon WITHOUT confetti;
//  • a 6s auto-dismiss countdown (bottom border) removes the ribbon; tapping it or
//    the × stops the countdown;
//  • manually closing the popup dismisses the ribbon (supersedes dec-4's
//    "popup close ≠ dismiss").

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { WhatsNewRibbon } from './WhatsNewRibbon';
import type { WhatsNewEntry } from '../../api/whatsNew';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-200/acs/ac-${n}`;

function entry(handle: string, publishedAt: string, over: Partial<WhatsNewEntry> = {}): WhatsNewEntry {
  return {
    id: handle,
    sourceSpecRef: `mindset-prod/memex-building-itself/specs/${handle}`,
    sourceSpecHandle: handle,
    title: `Title ${handle}`,
    what: `What ${handle}.`,
    why: `Why ${handle}.`,
    publishedAt,
    ...over,
  };
}

// newest-first
const ENTRIES = [
  entry('spec-200', '2026-06-08T10:00:00Z'),
  entry('spec-199', '2026-06-07T10:00:00Z'),
];

function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: reduce,
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  setReducedMotion(false);
});
afterEach(() => cleanup());

describe('WhatsNewRibbon (spec-200 t-5)', () => {
  it('renders the ribbon for an unseen entry, fires confetti, and opens the popup newest-first (ac-11)', async () => {
    // autoDismissMs=0 keeps the ribbon up for the assertions (no countdown timer).
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} onExplain={() => {}} autoDismissMs={0} />);

    const ribbon = await screen.findByTestId('whats-new-ribbon');
    expect(ribbon).toBeTruthy();
    // Confetti burst on slide-up. Use findBy (not getBy): confetti mounts one
    // effect-tick after the ribbon, so a synchronous query races the render in CI.
    expect(await screen.findByTestId('whats-new-confetti')).toBeTruthy();

    // Click opens the popup with both entries, in the given (newest-first) order.
    fireEvent.click(ribbon);
    const popup = await screen.findByTestId('whats-new-popup');
    const headings = popup.querySelectorAll('h3');
    expect(Array.from(headings).map((h) => h.textContent)).toEqual(['Title spec-200', 'Title spec-199']);
    expect(popup.textContent).toContain('What spec-200.');
    expect(popup.textContent).toContain('Why spec-200.');

    tagAc(AC(11));
  });

  it('skips confetti under prefers-reduced-motion but still shows the ribbon', async () => {
    setReducedMotion(true);
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} autoDismissMs={0} />);
    expect(await screen.findByTestId('whats-new-ribbon')).toBeTruthy();
    expect(screen.queryByTestId('whats-new-confetti')).toBeNull();
  });

  it('fires confetti only on the first sighting of an entry, not on a repeat visit', async () => {
    const { unmount } = render(<WhatsNewRibbon fetcher={async () => ENTRIES} autoDismissMs={0} />);
    expect(await screen.findByTestId('whats-new-confetti')).toBeTruthy();
    unmount();

    // Same entries, fresh mount (a "next visit") — ribbon shows, confetti does not.
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} autoDismissMs={0} />);
    expect(await screen.findByTestId('whats-new-ribbon')).toBeTruthy();
    expect(screen.queryByTestId('whats-new-confetti')).toBeNull();
  });
});

describe('WhatsNewRibbon dismiss + countdown (spec-200 t-6)', () => {
  beforeEach(() => setReducedMotion(true)); // immediate fly-home + no confetti timers

  it('the ribbon × dismisses immediately and persists the marker (ac-12)', async () => {
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} autoDismissMs={0} />);
    await screen.findByTestId('whats-new-ribbon');

    fireEvent.click(screen.getByTestId('whats-new-ribbon-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('whats-new-ribbon')).toBeNull());
    expect(window.localStorage.getItem('whats-new:dismissed-at')).toBe('2026-06-08T10:00:00Z');

    tagAc(AC(12));
  });

  it('manually closing the popup dismisses the ribbon (popup close → fly home)', async () => {
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} autoDismissMs={0} />);
    const ribbon = await screen.findByTestId('whats-new-ribbon');

    // Tap the ribbon → popup opens (and the countdown, if any, stops).
    fireEvent.click(ribbon);
    await screen.findByTestId('whats-new-popup');

    // Closing the popup (scrim) now dismisses the ribbon — it flies home and goes.
    fireEvent.click(screen.getByTestId('whats-new-scrim'));
    await waitFor(() => expect(screen.queryByTestId('whats-new-popup')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('whats-new-ribbon')).toBeNull());
    expect(window.localStorage.getItem('whats-new:dismissed-at')).toBe('2026-06-08T10:00:00Z');
  });

  it('auto-dismisses after the countdown elapses', async () => {
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} autoDismissMs={300} />);
    await screen.findByTestId('whats-new-ribbon');
    // The countdown border is present while the ribbon waits.
    expect(screen.getByTestId('whats-new-countdown')).toBeTruthy();
    // After the countdown the ribbon flies home and unmounts.
    await waitFor(() => expect(screen.queryByTestId('whats-new-ribbon')).toBeNull(), { timeout: 2000 });
    expect(window.localStorage.getItem('whats-new:dismissed-at')).toBe('2026-06-08T10:00:00Z');
  });

  it('tapping the ribbon stops the countdown — it does not auto-dismiss', async () => {
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} autoDismissMs={300} />);
    const ribbon = await screen.findByTestId('whats-new-ribbon');
    fireEvent.click(ribbon); // open popup → stops countdown
    await screen.findByTestId('whats-new-popup');
    // The countdown indicator is gone and the ribbon does not auto-dismiss.
    expect(screen.queryByTestId('whats-new-countdown')).toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.getByTestId('whats-new-popup')).toBeTruthy();
    expect(screen.getByTestId('whats-new-ribbon')).toBeTruthy();
  });

  it('stays dismissed across reloads until a NEWER entry publishes (ac-12)', async () => {
    // Marker already at the newest entry's time → ribbon should not show.
    window.localStorage.setItem('whats-new:dismissed-at', '2026-06-08T10:00:00Z');
    const { unmount } = render(<WhatsNewRibbon fetcher={async () => ENTRIES} autoDismissMs={0} />);
    await waitFor(() => {}); // let fetch resolve
    expect(screen.queryByTestId('whats-new-ribbon')).toBeNull();
    unmount();

    // A newer entry publishes → ribbon reappears.
    const newer = [entry('spec-201', '2026-06-09T10:00:00Z'), ...ENTRIES];
    render(<WhatsNewRibbon fetcher={async () => newer} autoDismissMs={0} />);
    expect(await screen.findByTestId('whats-new-ribbon')).toBeTruthy();

    tagAc(AC(12));
  });
});
