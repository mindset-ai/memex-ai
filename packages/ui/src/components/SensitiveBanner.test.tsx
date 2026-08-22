// spec-535 t-7 — the warning surface, near the title.
//
// dec-4 split the setter from the signal. The SETTER is a byline pill (t-6); this
// is the SIGNAL, and it deliberately does not live on that row: everything there
// is small, grey, neutral metadata, and a danger signal wearing that costume is
// camouflaged by it — the visual form of the failure spec-240 dec-1 recorded.
// dec-3 made the identical call on the MCP surface, so doing the opposite here
// would be the product contradicting itself about one signal.
//
// Visible to EVERYONE, unlike the setter. A reader with no write access is
// precisely the person who most needs to know to ask first.

import { describe, it, expect, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen } from '@testing-library/react';
import { SensitiveBanner } from './SensitiveBanner';

vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: false }),
}));

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;

describe('SensitiveBanner (spec-535 t-7)', () => {
  it('ac-18: warns and names the contact', () => {
    tagAc(AC(18));
    render(<SensitiveBanner contactName="Robin" />);

    const banner = screen.getByTestId('sensitive-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('Robin');
    expect(banner.textContent?.toLowerCase()).toContain('contact');
  });

  it('ac-18: a screen reader is told, not left to infer from colour', () => {
    tagAc(AC(18));
    render(<SensitiveBanner contactName="Robin" />);

    // Announced rather than skipped as decoration. `status` (polite) over
    // `alert` (assertive) on purpose: the flag is advisory and interrupts nobody.
    const banner = screen.getByRole('status');
    expect(banner).toBe(screen.getByTestId('sensitive-banner'));
  });

  it('ac-18: it does not depend on colour alone — the word is in the text', () => {
    tagAc(AC(18));
    render(<SensitiveBanner contactName="Robin" />);

    // Strip every class and the meaning must survive. This is the check that
    // actually holds the "not colour alone" promise; asserting a class name would
    // pass while conveying nothing to someone who cannot see it.
    const text = screen.getByTestId('sensitive-banner').textContent ?? '';
    expect(text.toLowerCase()).toContain('sensitive');
  });

  it('ac-18: it says it blocks nothing, so a cautious reader does not stop', () => {
    tagAc(AC(18));
    render(<SensitiveBanner contactName="Robin" />);

    // ac-3's promise has to be legible AT the warning. Without it the honest
    // reading of a red banner is "do not proceed", which is not what this means.
    const text = screen.getByTestId('sensitive-banner').textContent?.toLowerCase() ?? '';
    expect(text).toMatch(/blocks nothing|not a lock|advisory/);
  });

  it('ac-18: with no recorded contact it still warns, naming no one', () => {
    tagAc(AC(18));
    render(<SensitiveBanner contactName={null} />);

    const text = screen.getByTestId('sensitive-banner').textContent ?? '';
    expect(text.toLowerCase()).toContain('sensitive');
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('ac-18: a reader without write access still sees the warning', () => {
    tagAc(AC(18));
    // The mock above pins canWrite=false for this whole file. Only the SETTER is
    // gated (t-6); gating the warning too would hide it from the people least
    // able to judge the risk themselves.
    render(<SensitiveBanner contactName="Robin" />);
    expect(screen.getByTestId('sensitive-banner')).toBeInTheDocument();
  });
});
