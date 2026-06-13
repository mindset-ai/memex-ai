// spec-200 (2026-06-13 behaviour pass) — the WhatsNewContext that lets the sidebar
// user menu re-open the What's New popup after the ribbon has been dismissed (req 5),
// and gates the menu item on feed availability.

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhatsNewProvider, useWhatsNew } from './WhatsNewContext';
import { WhatsNewRibbon } from './WhatsNewRibbon';
import type { WhatsNewEntry } from '../../api/whatsNew';

const ENTRY: WhatsNewEntry = {
  id: 'spec-200',
  sourceSpecRef: 'mindset-prod/memex-building-itself/specs/spec-200',
  sourceSpecHandle: 'spec-200',
  title: 'See what shipped',
  what: "A What's New feed.",
  why: 'You always know what changed.',
  publishedAt: '2026-06-08T10:00:00Z',
};

// Stand-in for the sidebar user menu — shows the item only when a feed exists.
function FakeMenu() {
  const { available, openPopup } = useWhatsNew();
  if (!available) return null;
  return (
    <button data-testid="menu-whats-new" onClick={openPopup}>
      What's New
    </button>
  );
}

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
});
afterEach(() => cleanup());

describe('WhatsNewContext', () => {
  it('the menu item appears only when the feed has entries, and re-opens the popup after dismissal', async () => {
    render(
      <WhatsNewProvider>
        <FakeMenu />
        <WhatsNewRibbon fetcher={async () => [ENTRY]} autoDismissMs={0} />
      </WhatsNewProvider>,
    );

    // The menu item shows once the feed resolves.
    await screen.findByTestId('menu-whats-new');
    // Dismiss the ribbon via its ×.
    fireEvent.click(await screen.findByTestId('whats-new-ribbon-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('whats-new-ribbon')).toBeNull());

    // Menu item is still there (feed still has entries) and re-opens the popup.
    fireEvent.click(screen.getByTestId('menu-whats-new'));
    expect(await screen.findByTestId('whats-new-popup')).toBeTruthy();
  });

  it('shows no menu item when the feed is empty', async () => {
    render(
      <WhatsNewProvider>
        <FakeMenu />
        <WhatsNewRibbon fetcher={async () => []} autoDismissMs={0} />
      </WhatsNewProvider>,
    );
    await waitFor(() => {});
    expect(screen.queryByTestId('menu-whats-new')).toBeNull();
  });
});
