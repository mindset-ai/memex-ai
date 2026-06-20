// Component tests for the opt-in consent banner (spec-254 t-3) — jsdom + RTL.
//
// Accept → consent recorded + visitor_id minted/persisted (ac-7 client arm).
// No banner / no mint before a choice, on decline, or under DNT (ac-12).

import { describe, it, expect, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VisitorConsent } from './VisitorConsent';
import { getConsent } from '../lib/visitorConsent';
import { VISITOR_COOKIE, VISITOR_LS_KEY } from '../lib/visitorId';

const AC = 'mindset-prod/memex-building-itself/specs/spec-254/acs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cookieValue(): string | undefined {
  const m = document.cookie.match(new RegExp('(?:^|; )' + VISITOR_COOKIE + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : undefined;
}
function setDnt(on: boolean): void {
  Object.defineProperty(window.navigator, 'doNotTrack', { value: on ? '1' : undefined, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  document.cookie = `${VISITOR_COOKIE}=; Path=/; Max-Age=0`;
  setDnt(false);
});

describe('VisitorConsent banner', () => {
  it('shows the banner when no choice has been made, and mints nothing yet (ac-12)', () => {
    tagAc(`${AC}/ac-12`);
    render(<VisitorConsent />);
    expect(screen.getByTestId('visitor-consent')).toBeTruthy();
    expect(cookieValue()).toBeUndefined();
    expect(getConsent()).toBeNull();
  });

  it('Accept records consent and mints + persists the visitor_id (ac-7)', () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-12`);
    render(<VisitorConsent />);
    fireEvent.click(screen.getByTestId('visitor-consent-accept'));
    expect(getConsent()).toBe('granted');
    expect(cookieValue()).toMatch(UUID_RE);
    expect(localStorage.getItem(VISITOR_LS_KEY)).toBe(cookieValue());
    expect(screen.queryByTestId('visitor-consent')).toBeNull();
  });

  it('Decline records the decline and writes no id (ac-12)', () => {
    tagAc(`${AC}/ac-12`);
    render(<VisitorConsent />);
    fireEvent.click(screen.getByTestId('visitor-consent-decline'));
    expect(getConsent()).toBe('denied');
    expect(cookieValue()).toBeUndefined();
    expect(localStorage.getItem(VISITOR_LS_KEY)).toBeNull();
    expect(screen.queryByTestId('visitor-consent')).toBeNull();
  });

  it('does not render under Do-Not-Track (ac-12)', () => {
    tagAc(`${AC}/ac-12`);
    setDnt(true);
    render(<VisitorConsent />);
    expect(screen.queryByTestId('visitor-consent')).toBeNull();
  });
});
