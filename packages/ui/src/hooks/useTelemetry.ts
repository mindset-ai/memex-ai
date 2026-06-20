import { useCallback, useEffect, useRef, useState } from 'react';
import { sanitizeUsageProps, type RegisteredEventName } from '@memex/shared';
import { BASE_URL, tenantBase, fetchWithRetry } from '../api/http';
import { hasConsent } from '../lib/visitorConsent';

// isDoNotTrack moved to the consent module (single source of truth, no import
// cycle); re-exported here so existing importers keep working.
export { isDoNotTrack } from '../lib/visitorConsent';

// useTelemetry — the BROWSER half of spec-244's front-end capture (t-6).
//
// Exposes track(name, props?): POSTs a REGISTERED event name + minimal props to
// `POST /api/<ns>/<mx>/telemetry`. Deliberately dull and unobtrusive:
//   - No-op under Do-Not-Track or a per-user opt-out (privacy — never even sent).
//   - No-op when there's no resolved tenant (nothing to attribute to). The SERVER
//     additionally no-ops anonymous callers, so an unauthenticated tab is harmless.
//   - Advisory: a failed POST is swallowed; telemetry never disrupts the UX.
//   - Props are sanitised client-side (content/email/long-text dropped) as
//     defence-in-depth; the server re-sanitises so content structurally can't land.
//
// `name` is typed `RegisteredEventName`, so a typo is a COMPILE error (dec-5).

const OPT_OUT_KEY = 'memex.telemetry.optout';

/** Per-user opt-out, persisted in localStorage. A secondary withdraw on top of
 *  consent (spec-244); under dec-4=B consent is the primary gate. */
export function isOptedOut(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The capture gate. It splits by who is asking (spec-326 dec-1):
 *
 *   - AUTHENTICATED → tracked BY DEFAULT under legitimate interest. The only gate
 *     is the per-user opt-out (the Art-21 right to object). Consent is NOT required
 *     and Do-Not-Track is NOT honored (dec-3: DNT has no UK/EU legal force; the
 *     settings opt-out is the meaningful, deliberate control).
 *   - ANONYMOUS → spec-254's opt-in is unchanged: capture only on an explicit
 *     'granted' consent (hasConsent already excludes Do-Not-Track) AND not opted out.
 *
 * The opt-out short-circuits both regimes — it is a withdraw that always wins.
 *
 * `authenticated` defaults to false (the anonymous opt-in gate), so callers on the
 * pre-auth path — `trackAnonymous` (spec-324) and any other anonymous caller — get
 * the correct opt-in semantics by calling `telemetryEnabled()` with no argument.
 */
export function telemetryEnabled(authenticated = false): boolean {
  if (isOptedOut()) return false;
  return authenticated || hasConsent();
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
    // spec-326 dec-1: authenticated users are tracked by default (opt-out only);
    // anonymous keep spec-254's opt-in. Default `authenticated=false` keeps every
    // existing caller on the anonymous (opt-in) gate until it opts in explicitly.
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
 * Fire a registered event WITHOUT a tenant — the PRE-AUTH path (spec-324). Posts to
 * the flat `/api/telemetry` ingress, which keys the event on the consent-gated
 * visitor_id cookie (or the session, if one happens to exist). Use this on pre-auth
 * surfaces (the signup / login screen) where `tenantBase()` is null and `track()`
 * would no-op — it is how the funnel HEAD (signup.form_viewed) is captured, so a
 * visitor seen before they have an identity can later be stitched to their user.
 *
 * Same privacy posture as track(): no-op under no-consent / Do-Not-Track / opt-out
 * (never sent), and the server additionally no-ops when there is no visitor_id and
 * no session — so a non-consenting visitor sends and stores nothing. Advisory.
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
