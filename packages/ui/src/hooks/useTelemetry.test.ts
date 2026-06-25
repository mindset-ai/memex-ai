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
import { useTelemetry, trackAnonymous, isOptedOut, routeTemplate, telemetryEnabled } from './useTelemetry';

const AC244 = 'mindset-prod/memex-building-itself/specs/spec-244/acs';
const AC326 = 'mindset-prod/memex-building-itself/specs/spec-326/acs';
const AC367 = 'mindset-prod/memex-building-itself/specs/spec-367/acs';

function setDnt(value: string): void {
  Object.defineProperty(navigator, 'doNotTrack', { value, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setDnt('0');
  // spec-367: consent is retired. Capture is on by default for everyone; the only
  // gate is the per-user opt-out. No consent setup is needed (or possible) any more.
});

describe('routeTemplate — never a concrete id or query (spec-244 ac-7)', () => {
  it('replaces handles / numbers / uuids and drops the query string', () => {
    tagAc(`${AC244}/ac-7`);
    expect(routeTemplate('/ns/mx/specs/spec-244?tab=decisions')).toBe('/ns/mx/specs/:id');
    expect(routeTemplate('/ns/mx/standards/12')).toBe('/ns/mx/standards/:id');
    expect(routeTemplate('/ns/mx/specs')).toBe('/ns/mx/specs');
  });
});

describe('useTelemetry.track — sanitised, advisory, opt-out only (spec-244 ac-7)', () => {
  it('sends a sanitised event by default (content props dropped client-side)', () => {
    tagAc(`${AC244}/ac-7`);
    const { result } = renderHook(() => useTelemetry(true));
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
    tagAc(`${AC244}/ac-7`);
    localStorage.setItem('memex.telemetry.optout', '1');
    const { result } = renderHook(() => useTelemetry(true));
    act(() => result.current.track('cta.clicked'));
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('still fires under Do-Not-Track (DNT not honoured — spec-367 ac-8 / spec-326 ac-8)', () => {
    tagAc(`${AC367}/ac-8`);
    tagAc(`${AC326}/ac-8`);
    setDnt('1');
    const { result } = renderHook(() => useTelemetry(true));
    act(() => result.current.track('cta.clicked'));
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  it('setOptOut persists and flips the reactive flag', () => {
    tagAc(`${AC244}/ac-7`);
    const { result } = renderHook(() => useTelemetry());
    expect(result.current.optedOut).toBe(false);
    act(() => result.current.setOptOut(true));
    expect(result.current.optedOut).toBe(true);
    expect(isOptedOut()).toBe(true);
  });
});

// spec-367 — the pre-auth path: identifier-less volume under legitimate interest.
// Fires for everyone not opted out; no consent, DNT not honoured, and it writes
// NOTHING to the device (no cookie, no localStorage id).
describe('trackAnonymous — stateless pre-signup capture (spec-367)', () => {
  it('posts to the FLAT /api/telemetry ingress with NO consent, sanitising props (ac-7)', () => {
    tagAc(`${AC367}/ac-7`);
    trackAnonymous('signup.form_viewed', { method: 'password', note: 'z'.repeat(200) });
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchWithRetry as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe('/api/telemetry'); // flat, tenant-less
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('signup.form_viewed');
    expect(body.props).toEqual({ method: 'password' }); // long content prop dropped client-side
  });

  it('fires the cta_clicked event the same way (ac-9)', () => {
    tagAc(`${AC367}/ac-9`);
    trackAnonymous('signup.cta_clicked', { method: 'password' });
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const [, init] = (fetchWithRetry as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(JSON.parse(init.body as string).name).toBe('signup.cta_clicked');
  });

  it('still fires under Do-Not-Track (DNT not honoured, ac-8)', () => {
    tagAc(`${AC367}/ac-8`);
    setDnt('1');
    trackAnonymous('signup.form_viewed');
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  it('no-ops when the user has explicitly opted out (the one gate, ac-8)', () => {
    tagAc(`${AC367}/ac-8`);
    localStorage.setItem('memex.telemetry.optout', '1');
    trackAnonymous('signup.form_viewed');
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it('writes NOTHING to cookie or localStorage — no identifier minted (ac-2, ac-7)', () => {
    tagAc(`${AC367}/ac-2`);
    tagAc(`${AC367}/ac-7`);
    const cookieBefore = document.cookie;
    const lsKeysBefore = Object.keys(localStorage).sort();
    trackAnonymous('signup.form_viewed', { method: 'password' });
    trackAnonymous('signup.cta_clicked', { method: 'password' });
    expect(document.cookie).toBe(cookieBefore); // no cookie set
    expect(Object.keys(localStorage).sort()).toEqual(lsKeysBefore); // no id persisted
  });
});

// telemetryEnabled collapses to the opt-out check (spec-367 dec-2): consent is gone,
// so authenticated and anonymous capture share ONE gate. The legacy `authenticated`
// argument no longer changes the result.
describe('telemetryEnabled — opt-out only (spec-367 ac-7)', () => {
  it('returns true by default for both anonymous and authenticated callers', () => {
    tagAc(`${AC367}/ac-7`);
    localStorage.removeItem('memex.telemetry.consent'); // no such concept any more
    expect(telemetryEnabled(false)).toBe(true);
    expect(telemetryEnabled(true)).toBe(true);
  });

  it('returns true under Do-Not-Track (DNT not honoured, ac-8)', () => {
    tagAc(`${AC367}/ac-8`);
    setDnt('1');
    expect(telemetryEnabled(false)).toBe(true);
    expect(telemetryEnabled(true)).toBe(true);
  });

  it('the per-user opt-out wins for everyone (the right to object)', () => {
    tagAc(`${AC367}/ac-7`);
    tagAc(`${AC326}/ac-3`); // the settings opt-out remains available + effective
    localStorage.setItem('memex.telemetry.optout', '1');
    expect(telemetryEnabled(false)).toBe(false);
    expect(telemetryEnabled(true)).toBe(false);
  });
});

describe('useTelemetry — authenticated track() still fires by default (spec-326 ac-1)', () => {
  it('an authenticated user is tracked with no consent choice', () => {
    tagAc(`${AC326}/ac-1`);
    const { result } = renderHook(() => useTelemetry(true));
    act(() => result.current.track('nav.route_changed', { route: '/ns/mx' }));
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });
});
