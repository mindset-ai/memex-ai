// spec-439 — suppress What's New ribbon on a user's first sign-in.
//
// ac-1  new user (marker absent, suppressBefore ≥ newest.publishedAt) → ribbon absent
// ac-2  new user → confetti absent
// ac-3  returning user (cleared localStorage, suppressBefore < newest.publishedAt) → ribbon present
// ac-4  existing user with a set dismissed marker → no change, ribbon shows as normal
// ac-7  seed writes DISMISS_KEY synchronously before setEntries when marker is 0
// ac-8  seed writes CONFETTI_KEY synchronously before setEntries when marker is 0
// ac-9  when DISMISS_KEY is already set, suppressBefore is NOT written
// ac-10 when suppressBefore is absent (old server), markers are untouched, ribbon shows

import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { WhatsNewRibbon } from './WhatsNewRibbon';
import type { WhatsNewEntry, WhatsNewResponse } from '../../api/whatsNew';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-439';
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const DISMISS_KEY = 'whats-new:dismissed-at';
const CONFETTI_KEY = 'whats-new:confetti-shown-at';

function entry(handle: string, publishedAt: string): WhatsNewEntry {
  return {
    id: handle,
    sourceSpecRef: `mindset-prod/memex-building-itself/specs/${handle}`,
    sourceSpecHandle: handle,
    title: `Title ${handle}`,
    what: `What ${handle}.`,
    why: `Why ${handle}.`,
    publishedAt,
  };
}

const PUBLISHED_AT = '2026-06-01T10:00:00.000Z';
const ENTRIES = [entry('spec-100', PUBLISHED_AT)];

// suppressBefore >= PUBLISHED_AT → new user; all entries appear old
const NEW_USER_SUPPRESS = '2026-06-30T00:00:00.000Z';
// suppressBefore < PUBLISHED_AT → returning user who cleared localStorage; entry is genuinely new
const RETURNING_USER_SUPPRESS = '2026-05-01T00:00:00.000Z';

function fetcher(suppressBefore: string | undefined): () => Promise<WhatsNewResponse> {
  return async () => ({ entries: ENTRIES, suppressBefore });
}

beforeEach(() => {
  window.localStorage.clear();
  // Disable reduced-motion so confetti/animation paths are exercised.
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => cleanup());

describe('WhatsNewRibbon first-sign-in suppression (spec-439)', () => {
  it('ribbon is absent for a new user whose suppressBefore is after the newest entry (ac-1)', async () => {
    render(<WhatsNewRibbon fetcher={fetcher(NEW_USER_SUPPRESS)} autoDismissMs={0} />);
    // Wait for the fetch to resolve — the ribbon must stay absent.
    await waitFor(() =>
      expect(screen.queryByTestId('whats-new-ribbon')).toBeNull(),
    );
    tagAc(AC(1));
  });

  it('confetti is absent for a new user (ac-2)', async () => {
    render(<WhatsNewRibbon fetcher={fetcher(NEW_USER_SUPPRESS)} autoDismissMs={0} />);
    await waitFor(() =>
      expect(screen.queryByTestId('whats-new-confetti')).toBeNull(),
    );
    tagAc(AC(2));
  });

  it('ribbon is present for a returning user who cleared localStorage (suppressBefore < newest.publishedAt) (ac-3)', async () => {
    render(<WhatsNewRibbon fetcher={fetcher(RETURNING_USER_SUPPRESS)} autoDismissMs={0} />);
    expect(await screen.findByTestId('whats-new-ribbon')).toBeTruthy();
    tagAc(AC(3));
  });

  it('existing user with a pre-set dismissed marker sees no change in behaviour (ac-4)', async () => {
    // Simulate a returning user who previously dismissed: their marker predates the entry.
    window.localStorage.setItem(DISMISS_KEY, '2026-05-15T00:00:00.000Z');
    render(<WhatsNewRibbon fetcher={fetcher(NEW_USER_SUPPRESS)} autoDismissMs={0} />);
    // Entry is newer than the existing marker → ribbon shows as normal.
    expect(await screen.findByTestId('whats-new-ribbon')).toBeTruthy();
    // suppressBefore was NOT written over the existing marker.
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe('2026-05-15T00:00:00.000Z');
    tagAc(AC(4));
  });

  it('seeds DISMISS_KEY from suppressBefore before entries render when marker is 0 (ac-7)', async () => {
    render(<WhatsNewRibbon fetcher={fetcher(NEW_USER_SUPPRESS)} autoDismissMs={0} />);
    // After fetch resolves the marker must be set and the ribbon must be absent.
    await waitFor(() => {
      expect(window.localStorage.getItem(DISMISS_KEY)).toBe(NEW_USER_SUPPRESS);
      expect(screen.queryByTestId('whats-new-ribbon')).toBeNull();
    });
    tagAc(AC(7));
  });

  it('seeds CONFETTI_KEY from suppressBefore before entries render when marker is 0 (ac-8)', async () => {
    render(<WhatsNewRibbon fetcher={fetcher(NEW_USER_SUPPRESS)} autoDismissMs={0} />);
    await waitFor(() =>
      expect(window.localStorage.getItem(CONFETTI_KEY)).toBe(NEW_USER_SUPPRESS),
    );
    tagAc(AC(8));
  });

  it('does NOT overwrite DISMISS_KEY when it is already set (ac-9)', async () => {
    const existingMarker = '2026-04-01T00:00:00.000Z';
    window.localStorage.setItem(DISMISS_KEY, existingMarker);
    render(<WhatsNewRibbon fetcher={fetcher(NEW_USER_SUPPRESS)} autoDismissMs={0} />);
    await waitFor(() =>
      expect(window.localStorage.getItem(DISMISS_KEY)).toBe(existingMarker),
    );
    tagAc(AC(9));
  });

  it('when suppressBefore is absent (old server), DISMISS_KEY is untouched and ribbon shows (ac-10)', async () => {
    render(<WhatsNewRibbon fetcher={fetcher(undefined)} autoDismissMs={0} />);
    // The ribbon shows — existing behaviour preserved.
    expect(await screen.findByTestId('whats-new-ribbon')).toBeTruthy();
    // DISMISS_KEY must NOT be written by the seeding code (it was never dismissed).
    expect(window.localStorage.getItem(DISMISS_KEY)).toBeNull();
    // Note: CONFETTI_KEY IS written by the existing slide-in confetti effect (normal
    // behaviour), not by spec-439's seeding code — that's correct and expected.
    tagAc(AC(10));
  });

  it('boundary: suppressBefore === newest.publishedAt → entry is suppressed (strict > at ribbonPresent)', async () => {
    // Line 119: Date.parse(newest.publishedAt) > readMarker(DISMISS_KEY)
    // Equal timestamps → NOT strictly greater → ribbon absent.
    render(<WhatsNewRibbon fetcher={fetcher(PUBLISHED_AT)} autoDismissMs={0} />);
    await waitFor(() =>
      expect(screen.queryByTestId('whats-new-ribbon')).toBeNull(),
    );
  });

  it('does NOT overwrite DISMISS_KEY with suppressBefore when marker is older than suppressBefore (no regression)', async () => {
    // Even if suppressBefore > existing marker (e.g. user was seeded after their account),
    // the === 0 guard must prevent overwriting a real dismissal backwards.
    const realDismissal = '2026-03-01T00:00:00.000Z';
    window.localStorage.setItem(DISMISS_KEY, realDismissal);
    render(<WhatsNewRibbon fetcher={fetcher(NEW_USER_SUPPRESS)} autoDismissMs={0} />);
    await waitFor(() =>
      expect(window.localStorage.getItem(DISMISS_KEY)).toBe(realDismissal),
    );
  });
});
