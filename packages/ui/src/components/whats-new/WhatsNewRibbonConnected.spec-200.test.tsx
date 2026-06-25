// spec-200 t-7 — the ear wires to the spec-190 voice session (seed-the-guide).
//
// ac-13 — clicking an entry's ear starts a session SEEDED with that entry's text,
//         and the ear carries the Specky avatar.
// ac-14 — where the guide can't run (mic unavailable), the ear is hidden — no
//         orphaned control (mirrors spec-190's isAffordanceDisabled gate).

import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { WhatsNewRibbonConnected, formatEntryForGuide } from './WhatsNewRibbonConnected';
import type { WhatsNewEntry } from '../../api/whatsNew';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-200/acs/ac-${n}`;

// Controllable voice-session mock. spec-222: the voice surface now ships from
// @memex/guide-sdk, so we override only useVoiceSession and keep the real Specky +
// isAffordanceDisabled (the ribbon renders Specky; the gate uses the real helper).
const startMock = vi.fn();
let micAvailable = true;
let status = 'inactive';
vi.mock('@memex/guide-sdk', async (orig) => ({
  ...(await orig<typeof import('@memex/guide-sdk')>()),
  useVoiceSession: () => ({ start: startMock, micAvailable, status }),
}));

// Stub the feed fetch so the ribbon shows.
const ENTRY: WhatsNewEntry = {
  id: 'spec-200',
  sourceSpecRef: 'mindset-prod/memex-building-itself/specs/spec-200',
  sourceSpecHandle: 'spec-200',
  title: 'See what shipped',
  what: 'A What\'s New feed.',
  why: 'You always know what changed.',
  publishedAt: '2026-06-08T10:00:00Z',
};
vi.mock('../../api/whatsNew', async (orig) => ({
  ...(await orig<typeof import('../../api/whatsNew')>()),
  fetchWhatsNew: async () => [ENTRY],
}));

function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: reduce, media: q, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  setReducedMotion(true);
  startMock.mockReset();
  micAvailable = true;
  status = 'inactive';
});
afterEach(() => cleanup());

describe('WhatsNewRibbonConnected (spec-200 t-7)', () => {
  it('ear starts a session seeded with the entry text; ear carries Specky (ac-13)', async () => {
    render(<WhatsNewRibbonConnected />);
    fireEvent.click(await screen.findByTestId('whats-new-ribbon'));

    const ear = await screen.findByTestId('whats-new-ear-spec-200');
    // Specky avatar (an <img>) rides inside the ear button.
    expect(ear.querySelector('img')).toBeTruthy();

    fireEvent.click(ear);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith(formatEntryForGuide(ENTRY));
    // The seed carries both What and Why so Specky can explain THIS entry.
    expect(startMock.mock.calls[0][0]).toContain('A What\'s New feed.');
    expect(startMock.mock.calls[0][0]).toContain('You always know what changed.');

    tagAc(AC(13));
    // Scope ac-5: every entry carries an ear that invokes the voice guide (spec-190)
    // with Specky (spec-197) as narrator.
    tagAc(AC(5));
  });

  it('hides the ear when the guide cannot run (mic unavailable) — ac-14', async () => {
    micAvailable = false;
    render(<WhatsNewRibbonConnected />);
    fireEvent.click(await screen.findByTestId('whats-new-ribbon'));
    await screen.findByTestId('whats-new-popup');

    expect(screen.queryByTestId('whats-new-ear-spec-200')).toBeNull();
    tagAc(AC(14));
  });
});
