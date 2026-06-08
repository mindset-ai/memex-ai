// spec-200 t-5 / t-6 — the What's New ribbon + popup + dismiss semantics.
//
// ac-11 — ribbon renders when an undismissed entry exists; click opens the popup
//         (entries newest-first, What/Why shown). Confetti fires on slide-up.
// ac-12 — popup close ≠ dismiss; only the ribbon × dismisses; dismissal persists
//         per-user (localStorage) and a newer entry re-shows the ribbon.

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
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} onExplain={() => {}} />);

    const ribbon = await screen.findByTestId('whats-new-ribbon');
    expect(ribbon).toBeTruthy();
    // Confetti burst on slide-up.
    expect(screen.getByTestId('whats-new-confetti')).toBeTruthy();

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
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} />);
    expect(await screen.findByTestId('whats-new-ribbon')).toBeTruthy();
    expect(screen.queryByTestId('whats-new-confetti')).toBeNull();
  });
});

describe('WhatsNewRibbon dismiss semantics (spec-200 t-6)', () => {
  beforeEach(() => setReducedMotion(true)); // avoid confetti timers in these

  it('popup close does NOT dismiss; only the ribbon × dismisses + persists (ac-12)', async () => {
    render(<WhatsNewRibbon fetcher={async () => ENTRIES} />);
    const ribbon = await screen.findByTestId('whats-new-ribbon');

    // Open then close the popup via scrim — ribbon must remain.
    fireEvent.click(ribbon);
    await screen.findByTestId('whats-new-popup'); // ribbon → popup (scope ac-2)
    tagAc(AC(2));
    fireEvent.click(await screen.findByTestId('whats-new-scrim'));
    await waitFor(() => expect(screen.queryByTestId('whats-new-popup')).toBeNull());
    expect(screen.getByTestId('whats-new-ribbon')).toBeTruthy(); // still there

    // The ribbon's own × dismisses it AND persists the marker.
    fireEvent.click(screen.getByTestId('whats-new-ribbon-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('whats-new-ribbon')).toBeNull());
    expect(window.localStorage.getItem('whats-new:dismissed-at')).toBe('2026-06-08T10:00:00Z');

    tagAc(AC(12));
    // Scope ac-3: ribbon persists until its own × (popup close ≠ dismiss) and the
    // dismissal is remembered per user.
    tagAc(AC(3));
  });

  it('stays dismissed across reloads until a NEWER entry publishes (ac-12)', async () => {
    // Marker already at the newest entry's time → ribbon should not show.
    window.localStorage.setItem('whats-new:dismissed-at', '2026-06-08T10:00:00Z');
    const { unmount } = render(<WhatsNewRibbon fetcher={async () => ENTRIES} />);
    await waitFor(() => {}); // let fetch resolve
    expect(screen.queryByTestId('whats-new-ribbon')).toBeNull();
    unmount();

    // A newer entry publishes → ribbon reappears.
    const newer = [entry('spec-201', '2026-06-09T10:00:00Z'), ...ENTRIES];
    render(<WhatsNewRibbon fetcher={async () => newer} />);
    expect(await screen.findByTestId('whats-new-ribbon')).toBeTruthy();

    tagAc(AC(12));
  });
});
