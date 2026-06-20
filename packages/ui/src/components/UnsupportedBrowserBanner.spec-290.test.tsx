import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  UnsupportedBrowserBanner,
  isModernCssSupported,
} from './UnsupportedBrowserBanner';

// spec-290 (dec-3) — below-floor browser banner. ac-10 = the detection +
// conditional-render mechanism; ac-6 = the user-facing upgrade notice.
const AC6 = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-6';
const AC10 = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-10';

/** Force the color-mix feature probe on/off. */
function stubColorMix(supported: boolean) {
  vi.stubGlobal('CSS', { supports: vi.fn(() => supported) });
}

afterEach(() => vi.unstubAllGlobals());

describe('spec-290: below-floor browser banner', () => {
  it('ac-10: detection follows color-mix support both ways', () => {
    tagAc(AC10);
    stubColorMix(true);
    expect(isModernCssSupported()).toBe(true);
    stubColorMix(false);
    expect(isModernCssSupported()).toBe(false);
  });

  it('ac-10: renders nothing on a modern (above-floor) browser', () => {
    tagAc(AC10);
    stubColorMix(true);
    const { container } = render(<UnsupportedBrowserBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ac-6: shows an upgrade notice on a below-floor browser', () => {
    tagAc(AC6);
    stubColorMix(false);
    render(<UnsupportedBrowserBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(/out of date/i);
    expect(banner).toHaveTextContent(/update|upgrade|chrome|safari|firefox/i);
  });

  it('ac-6: the notice is keyboard-dismissible', async () => {
    tagAc(AC6);
    stubColorMix(false);
    const user = userEvent.setup();
    render(<UnsupportedBrowserBanner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    // Reach the dismiss control by keyboard and activate it.
    await user.tab();
    expect(screen.getByRole('button', { name: /dismiss/i })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
