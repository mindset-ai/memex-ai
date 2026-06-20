import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the HTTP layer so track() / trackAnonymous() never hit the network.
vi.mock('../api/http', () => ({
  BASE_URL: '/api',
  tenantBase: vi.fn(() => 'https://app/api/ns/mx'),
  fetchWithRetry: vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
}));

import { fetchWithRetry } from '../api/http';
import { setConsent } from '../lib/visitorConsent';
import { useTelemetry, trackAnonymous, isOptedOut, routeTemplate, telemetryEnabled } from './useTelemetry';

const AC = 'mindset-prod/memex-building-itself/specs/spec-244/acs';
const AC324 = 'mindset-prod/memex-building-itself/specs/spec-324/acs';
const AC326 = 'mindset-prod/memex-building-itself/specs/spec-326/acs';

function setDnt(value: string): void {
  Object.defineProperty(navigator, 'doNotTrack', { value, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setDnt('0');
  // spec-254 dec-4: telemetry is now consent-gated (opt-in) — track() no-ops
  // until the visitor explicitly accepts. A consented visitor is the baseline for
  // these spec-244 track() tests; the opt-out / DNT cases below each then prove
  // their gate ON TOP of consent (DNT in particular overrides a 'granted' choice).
  setConsent('granted');
});

describe('routeTemplate — never a concrete id or query (ac-7)', () => {
  it('replaces handles / numbers / uuids and drops the query string', () => {
    tagAc(`${AC}/ac-7`);
    expect(routeTemplate('/ns/mx/specs/spec-244?tab=decisions')).toBe('/ns/mx/specs/:id');
    expect(routeTemplate('/ns/mx/standards/12')).toBe('/ns/mx/standards/:id');
    expect(routeTemplate('/ns/mx/specs')).toBe('/ns/mx/specs');
  });
});

describe('useTelemetry.track — gated, sanitised, advisory (ac-7)', () => {
  it('sends a sanitised event when enabled (content props dropped client-side)', () => {
    tagAc(`${AC}/ac-7`);
    const { result } = renderHook(() => useTelemetry());
    act(() => result.current.track('cta.clicked', { id: 'new_spec', note: 'y'.repeat(200) }));
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchWithRetry as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(url).toContain('/telemetry');
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('cta.clicked');
    expect(body.props).toEqual({ id: 'new_spec' }); // long note dropped before sending
  });

  it('no-ops when the user has opted out', () => {
    tagAc(`${AC}/ac-7`);
    localStorage.setItem('memex.telemetry.optout', '1');
    const { result } = renderHook(() => useTelemetry());
    act(() => result.current.track('cta.clicked'));
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('no-ops under Do-Not-Track', () => {
    tagAc(`${AC}/ac-7`);
    setDnt('1');
    const { result } = renderHook(() => useTelemetry());
    act(() => result.current.track('cta.clicked'));
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('setOptOut persists and flips the reactive flag', () => {
    tagAc(`${AC}/ac-7`);
    const { result } = renderHook(() => useTelemetry());
    expect(result.current.optedOut).toBe(false);
    act(() => result.current.setOptOut(true));
    expect(result.current.optedOut).toBe(true);
    expect(isOptedOut()).toBe(true);
  });
});

describe('trackAnonymous — the pre-auth path, same privacy gate (spec-324 ac-5)', () => {
  it('posts to the FLAT /api/telemetry ingress (no tenant) when enabled, sanitising props', () => {
    tagAc(`${AC324}/ac-5`);
    trackAnonymous('signup.form_viewed', { method: 'password', note: 'z'.repeat(200) });
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchWithRetry as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe('/api/telemetry'); // flat, tenant-less
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('signup.form_viewed');
    expect(body.props).toEqual({ method: 'password' }); // long content prop dropped client-side
  });

  it('no-ops without consent (spec-254 dec-4) — nothing sent pre-consent', () => {
    tagAc(`${AC324}/ac-5`);
    setConsent('denied');
    trackAnonymous('signup.form_viewed');
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('no-ops under Do-Not-Track', () => {
    tagAc(`${AC324}/ac-5`);
    setDnt('1');
    trackAnonymous('signup.form_viewed');
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('no-ops when the user has opted out', () => {
    tagAc(`${AC324}/ac-5`);
    localStorage.setItem('memex.telemetry.optout', '1');
    trackAnonymous('signup.form_viewed');
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});

// spec-326 — authenticated users are tracked BY DEFAULT (legitimate interest,
// opt-out), while the ANONYMOUS regime keeps spec-254's opt-in. These cases prove
// the split inside the SAME gate, so a regression in either direction is caught.
describe('telemetryEnabled — the authenticated/anonymous split (spec-326 ac-6)', () => {
  it('AUTHENTICATED: tracked with no consent choice, and under Do-Not-Track', () => {
    tagAc(`${AC326}/ac-6`);
    tagAc(`${AC326}/ac-8`); // dec-3: DNT has no legal force once authenticated
    // No setConsent() in this test — the visitor never chose. Anonymous would be
    // gated off; authenticated is tracked by default.
    localStorage.removeItem('memex.telemetry.consent');
    expect(telemetryEnabled(true)).toBe(true);
    setDnt('1'); // DNT is NOT honored once authenticated (dec-3)
    expect(telemetryEnabled(true)).toBe(true);
  });

  it('AUTHENTICATED: a prior anonymous DECLINE does not suppress capture', () => {
    tagAc(`${AC326}/ac-6`);
    setConsent('denied'); // declined while anonymous
    expect(telemetryEnabled(false)).toBe(false); // honored WHILE anonymous (ac-4)
    expect(telemetryEnabled(true)).toBe(true); // superseded once authenticated (ac-2/dec-1)
  });

  it('AUTHENTICATED: the per-user opt-out still wins (right to object, ac-3/ac-7)', () => {
    tagAc(`${AC326}/ac-3`); // the settings opt-out remains available + effective
    tagAc(`${AC326}/ac-7`);
    localStorage.setItem('memex.telemetry.optout', '1');
    expect(telemetryEnabled(true)).toBe(false);
  });

  it('ANONYMOUS: a declined visitor is NOT tracked while anonymous (ac-4, spec-254 dec-4 preserved)', () => {
    tagAc(`${AC326}/ac-4`);
    setConsent('denied'); // declined as an anonymous visitor
    expect(telemetryEnabled(false)).toBe(false); // not tracked while anonymous
    localStorage.removeItem('memex.telemetry.consent');
    expect(telemetryEnabled(false)).toBe(false); // undecided anonymous → also not tracked
  });

  it('ANONYMOUS: spec-254 opt-in is unchanged (granted on, DNT off, undecided off)', () => {
    tagAc(`${AC326}/ac-6`);
    localStorage.removeItem('memex.telemetry.consent');
    expect(telemetryEnabled(false)).toBe(false); // undecided → no capture
    setConsent('granted');
    expect(telemetryEnabled(false)).toBe(true); // granted → capture
    setDnt('1');
    expect(telemetryEnabled(false)).toBe(false); // DNT overrides granted while anonymous
  });
});

describe('useTelemetry(authenticated) — track() fires by default once authenticated (spec-326 ac-1)', () => {
  it('an authenticated user who never granted consent still has track() fire', () => {
    tagAc(`${AC326}/ac-1`);
    localStorage.removeItem('memex.telemetry.consent'); // no consent choice at all
    const { result } = renderHook(() => useTelemetry(true));
    act(() => result.current.track('nav.route_changed', { route: '/ns/mx' }));
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  it('the same user, anonymous (no auth, no consent), does NOT fire', () => {
    tagAc(`${AC326}/ac-1`);
    localStorage.removeItem('memex.telemetry.consent');
    const { result } = renderHook(() => useTelemetry(false));
    act(() => result.current.track('nav.route_changed', { route: '/ns/mx' }));
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
