import { useCallback, useEffect, useRef, useState } from 'react';
import { sanitizeUsageProps, type RegisteredEventName } from '@memex/shared';
import { BASE_URL, tenantBase, fetchWithRetry } from '../api/http';

// useTelemetry — the BROWSER half of spec-244's front-end capture (t-6).
//
// Exposes track(name, props?): POSTs a REGISTERED event name + minimal props to
// `POST /api/<ns>/<mx>/telemetry`. Deliberately dull and unobtrusive:
//   - No-op only under a per-user opt-out (the right to object). Consent is no
//     longer part of the model and Do-Not-Track is NOT honoured (spec-367 dec-3;
//     spec-326 dec-3 — DNT has no UK/EU legal force).
//   - No-op when there's no resolved tenant (nothing to attribute to). Pre-auth
//     callers use `trackAnonymous` against the flat ingress instead.
//   - Advisory: a failed POST is swallowed; telemetry never disrupts the UX.
//   - Props are sanitised client-side (content/email/long-text dropped) as
//     defence-in-depth; the server re-sanitises so content structurally can't land.
//
// `name` is typed `RegisteredEventName`, so a typo is a COMPILE error (dec-5).

const OPT_OUT_KEY = 'memex.telemetry.optout';

/** Per-user opt-out, persisted in localStorage. The single capture gate now that
 *  consent is retired (spec-367) — the Art-21 right to object. */
export function isOptedOut(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The capture gate. Consent is retired (spec-367, reversing spec-254 dec-4): every
 * visitor — authenticated or anonymous — is captured under legitimate interest, and
 * the ONLY gate is the per-user opt-out (the Art-21 right to object). Do-Not-Track is
 * NOT honoured (dec-3). Anonymous pre-signup capture is identifier-less volume, so
 * there is nothing left to gate on consent.
 *
 * The authenticated parameter is retained for call-site compatibility (track() and
 * the spec-326 tests still pass it) but no longer affects the result — underscored so
 * the unused-parameter check stays satisfied now that consent is gone.
 */
export function telemetryEnabled(_authenticated = false): boolean {
  return !isOptedOut();
}

// Replace id-shaped segments (handles like spec-7, bare numbers, uuids) with ':id'
// and drop any query string, so nav.route_changed records only the route TEMPLATE —
// never a concrete id or query (spec-244 registry rule).
const ID_SEGMENT_RE = /^([a-z]+-\d+|\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function routeTemplate(pathname: string): string {
  const path = pathname.split('?')[0];
  const segs = path.split('/').filter(Boolean).map((s) => (ID_SEGMENT_RE.test(s) ? ':id' : s));
  return '/' + segs.join('/');
}

export interface UseTelemetry {
  /** Fire a registered event. No-op under DNT / opt-out / no-tenant. */
  track: (name: RegisteredEventName, props?: Record<string, unknown>) => void;
  /** Whether the user has opted out (reactive). */
  optedOut: boolean;
  /** Set the per-user opt-out (persists to localStorage). */
  setOptOut: (value: boolean) => void;
}

export function useTelemetry(authenticated = false): UseTelemetry {
  const [optedOut, setOptedOut] = useState<boolean>(isOptedOut);

  const track = useCallback((name: RegisteredEventName, props?: Record<string, unknown>): void => {
    // Captured by default under legitimate interest; the only gate is the per-user
    // opt-out (spec-367 — consent retired, DNT not honoured).
    if (!telemetryEnabled(authenticated)) return;
    const base = tenantBase();
    if (!base) return;
    void fetchWithRetry(`${base}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, props: sanitizeUsageProps(props) }),
    }).catch(() => {
      // Advisory — telemetry must never disrupt the user's flow.
    });
  }, [authenticated]);

  const setOptOut = useCallback((value: boolean): void => {
    try {
      if (value) localStorage.setItem(OPT_OUT_KEY, '1');
      else localStorage.removeItem(OPT_OUT_KEY);
    } catch {
      // localStorage unavailable (private mode) — keep the in-memory state anyway.
    }
    setOptedOut(value);
  }, []);

  return { track, optedOut, setOptOut };
}

/**
 * Fire a registered event WITHOUT a tenant — the PRE-AUTH path. Posts to the flat
 * `/api/telemetry` ingress. Use this on pre-auth surfaces (the signup / login screen)
 * where `tenantBase()` is null and `track()` would no-op — it is how the funnel HEAD
 * (signup.form_viewed, signup.cta_clicked) is captured.
 *
 * spec-367 (reversing spec-254 dec-4): these events are IDENTIFIER-LESS volume under
 * legitimate interest. Nothing is minted (no cookie, no localStorage); the server
 * records the event with a null actor / null visitor_id. The only gate is the opt-out
 * (telemetryEnabled) — consent is retired and Do-Not-Track is not honoured. Advisory.
 */
export function trackAnonymous(name: RegisteredEventName, props?: Record<string, unknown>): void {
  if (!telemetryEnabled()) return;
  void fetchWithRetry(`${BASE_URL}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, props: sanitizeUsageProps(props) }),
  }).catch(() => {
    // Advisory — telemetry must never disrupt the user's flow.
  });
}

/**
 * Fire `nav.route_changed` whenever the route template changes. Mounted once at the
 * tenant root. Records the TEMPLATE only (routeTemplate strips ids + query). Pass
 * `null` to disable (e.g. for an anonymous visitor — the server would no-op anyway,
 * but there's no point sending).
 */
export function useTrackRouteChange(pathname: string | null): void {
  // A non-null pathname is the App's signal that this is an authenticated,
  // trackable context (App.tsx passes null for anonymous visitors). That same
  // signal IS the authenticated flag for the gate (spec-326 dec-1): a route we
  // actually track belongs to an authenticated user, captured by default.
  const { track } = useTelemetry(pathname !== null);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (pathname === null) return;
    const template = routeTemplate(pathname);
    if (last.current === template) return;

    // Defer to browser IDLE (with a setTimeout fallback) and cancel on unmount.
    // Telemetry must never sit on the navigation critical path: a fetch fired
    // synchronously on a route mount competes with redirects/reloads and can
    // destabilise navigation-timing-sensitive flows on slow hosts. Deferring means
    // a route you bounce straight off (a transient redirect, an immediate reload)
    // fires nothing — only a settled route is recorded.
    let cancelled = false;
    const fire = (): void => {
      if (cancelled) return;
      last.current = template;
      track('nav.route_changed', { route: template });
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (typeof w.requestIdleCallback === 'function') {
      idleId = w.requestIdleCallback(fire, { timeout: 2000 });
    } else {
      timerId = setTimeout(fire, 1200);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && typeof w.cancelIdleCallback === 'function') {
        w.cancelIdleCallback(idleId);
      }
      if (timerId !== undefined) clearTimeout(timerId);
    };
  }, [pathname, track]);
}
