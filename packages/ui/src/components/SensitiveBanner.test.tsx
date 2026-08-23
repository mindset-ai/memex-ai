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
    // ac-5 spans both surfaces: this is its WEB half — the warning reads as a
    // warning without any styling. Its MCP half (not another `Key: value` line
    // in the header) is pinned in spec-535-closeout.regression.test.ts.
    tagAc(AC(5));
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

// ── spec-535 dec-7 — the web half of the reworded ask ──────────────────────
//
// dec-4's argument was that one signal cannot say two different things on two
// surfaces. The MCP block now asks the reader to stop and ask their operator,
// names the trigger, and bounds the discharge; the banner has to carry the same
// contract or the split dec-4 rejected comes back through the copy.
describe('SensitiveBanner — dec-7 contract (spec-535)', () => {
  const AC7 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;

  it('ac-22: asks the reader to stop and ask, with the contact as a relay', () => {
    tagAc(AC7(22));
    render(<SensitiveBanner contactName="Robin" />);
    const text = (screen.getByTestId('sensitive-banner').textContent ?? '').toLowerCase();

    expect(text).toMatch(/stop and ask/);
    expect(text).toMatch(/person you are working with/);
    expect(text).toMatch(/tell them to contact robin/);
  });

  it('ac-23: names the trigger and the discharge', () => {
    tagAc(AC7(23));
    render(<SensitiveBanner contactName="Robin" />);
    const text = (screen.getByTestId('sensitive-banner').textContent ?? '').toLowerCase();

    expect(text).toMatch(/first change/);
    expect(text).toMatch(/one confirmation|covers this session/);
  });

  it('ac-24: says the same thing as the MCP block, and still says it blocks nothing', () => {
    tagAc(AC7(24));
    render(<SensitiveBanner contactName="Robin" />);
    const text = (screen.getByTestId('sensitive-banner').textContent ?? '').toLowerCase();

    // The shared contract, asserted on this surface too — that is what stops the
    // two surfaces drifting into saying different things about one flag.
    expect(text).toMatch(/stop and ask/);
    expect(text).toMatch(/one confirmation|covers this session/);
    expect(text).toMatch(/blocks nothing/);
    // std-1: banned in user-visible copy, and it already cost this Spec one fix.
    expect(text).not.toMatch(/\bteam\b/);
  });

  it('ac-23: with no contact recorded the ask and the scope survive', () => {
    tagAc(AC7(23));
    render(<SensitiveBanner contactName={null} />);
    const text = (screen.getByTestId('sensitive-banner').textContent ?? '').toLowerCase();

    expect(text).toMatch(/stop and ask/);
    expect(text).toMatch(/one confirmation|covers this session/);
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });
});
