// Unit tests for the consent-gated client mint (spec-254 t-3) — jsdom.
//
// Covers: nothing minted/persisted before consent / under DNT / on decline (ac-12);
// after consent a stable opaque UUID is minted + persisted to cookie + localStorage,
// stable across "reloads" (ac-7 client arm); inbound ?aid= is adopted (ac-8);
// withdraw clears both carriers.

import { describe, it, expect, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { setConsent, CONSENT_KEY } from './visitorConsent';
import {
  resolveVisitorIdWithConsent,
  currentVisitorId,
  clearVisitorId,
  VISITOR_COOKIE,
  VISITOR_LS_KEY,
} from './visitorId';

const AC = 'mindset-prod/memex-building-itself/specs/spec-254/acs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setDnt(on: boolean): void {
  Object.defineProperty(window.navigator, 'doNotTrack', {
    value: on ? '1' : undefined,
    configurable: true,
  });
}
function cookieValue(): string | undefined {
  const m = document.cookie.match(new RegExp('(?:^|; )' + VISITOR_COOKIE + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : undefined;
}
function grant(): void {
  setConsent('granted');
}

beforeEach(() => {
  localStorage.clear();
  document.cookie = `${VISITOR_COOKIE}=; Path=/; Max-Age=0`;
  window.history.replaceState({}, '', '/');
  setDnt(false);
});

describe('consent gate — nothing minted before opt-in (ac-12)', () => {
  it('returns null and writes nothing when no consent choice has been made', () => {
    tagAc(`${AC}/ac-12`);
    expect(resolveVisitorIdWithConsent()).toBeNull();
    expect(cookieValue()).toBeUndefined();
    expect(localStorage.getItem(VISITOR_LS_KEY)).toBeNull();
  });

  it('returns null and writes nothing when consent is denied', () => {
    tagAc(`${AC}/ac-12`);
    setConsent('denied');
    expect(resolveVisitorIdWithConsent()).toBeNull();
    expect(cookieValue()).toBeUndefined();
    expect(localStorage.getItem(VISITOR_LS_KEY)).toBeNull();
  });

  it('treats Do-Not-Track as a decline even when consent is "granted"', () => {
    tagAc(`${AC}/ac-12`);
    grant();
    setDnt(true);
    expect(resolveVisitorIdWithConsent()).toBeNull();
    expect(cookieValue()).toBeUndefined();
  });
});

describe('consent-gated mint (ac-7 client arm, ac-12)', () => {
  it('mints an opaque UUID and persists to cookie + localStorage after consent', () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-12`);
    tagAc(`${AC}/ac-5`); // opt-in gated, opaque random UUID — no content, no 3rd-party id
    grant();
    const id = resolveVisitorIdWithConsent();
    expect(id).toMatch(UUID_RE);
    expect(cookieValue()).toBe(id);
    expect(localStorage.getItem(VISITOR_LS_KEY)).toBe(id);
  });

  it('is stable across reloads — a second resolve returns the same id', () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-1`); // durable id stable across reloads / sessions
    grant();
    const first = resolveVisitorIdWithConsent();
    const second = resolveVisitorIdWithConsent(); // simulates a later page load
    expect(second).toBe(first);
    expect(currentVisitorId()).toBe(first);
  });
});

describe('?aid adoption — the marketing handoff (ac-8)', () => {
  it('adopts an inbound ?aid= UUID instead of minting fresh', () => {
    tagAc(`${AC}/ac-8`);
    grant();
    const aid = crypto.randomUUID();
    window.history.replaceState({}, '', `/?aid=${aid}`);
    const id = resolveVisitorIdWithConsent();
    expect(id).toBe(aid);
    expect(cookieValue()).toBe(aid);
    expect(localStorage.getItem(VISITOR_LS_KEY)).toBe(aid);
  });

  it('ignores a malformed ?aid and mints a fresh UUID', () => {
    tagAc(`${AC}/ac-8`);
    grant();
    window.history.replaceState({}, '', '/?aid=not-a-uuid');
    const id = resolveVisitorIdWithConsent();
    expect(id).toMatch(UUID_RE);
    expect(id).not.toBe('not-a-uuid');
  });
});

describe('withdraw clears the durable id', () => {
  it('removes the cookie and localStorage mirror', () => {
    tagAc(`${AC}/ac-12`);
    grant();
    resolveVisitorIdWithConsent();
    expect(currentVisitorId()).not.toBeNull();
    clearVisitorId();
    expect(cookieValue()).toBeUndefined();
    expect(localStorage.getItem(VISITOR_LS_KEY)).toBeNull();
  });
});
