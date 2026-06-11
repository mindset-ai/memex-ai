import { useCallback, useEffect, useRef, useState } from 'react';
import { sanitizeUsageProps, type RegisteredEventName } from '@memex/shared';
import { tenantBase, fetchWithRetry } from '../api/http';

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

/** Honour the browser Do-Not-Track signal across its vendor spellings. */
export function isDoNotTrack(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { msDoNotTrack?: string };
  const win = typeof window !== 'undefined' ? (window as Window & { doNotTrack?: string }) : undefined;
  const dnt = nav.doNotTrack ?? win?.doNotTrack ?? nav.msDoNotTrack;
  return dnt === '1' || dnt === 'yes';
}

/** Per-user opt-out, persisted in localStorage. */
export function isOptedOut(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Capture is allowed only when neither DNT nor the opt-out is set. */
export function telemetryEnabled(): boolean {
  return !isDoNotTrack() && !isOptedOut();
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

export function useTelemetry(): UseTelemetry {
  const [optedOut, setOptedOut] = useState<boolean>(isOptedOut);

  const track = useCallback((name: RegisteredEventName, props?: Record<string, unknown>): void => {
    if (!telemetryEnabled()) return;
    const base = tenantBase();
    if (!base) return;
    void fetchWithRetry(`${base}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, props: sanitizeUsageProps(props) }),
    }).catch(() => {
      // Advisory — telemetry must never disrupt the user's flow.
    });
  }, []);

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
 * Fire `nav.route_changed` whenever the route template changes. Mounted once at the
 * tenant root. Records the TEMPLATE only (routeTemplate strips ids + query). Pass
 * `null` to disable (e.g. for an anonymous visitor — the server would no-op anyway,
 * but there's no point sending).
 */
export function useTrackRouteChange(pathname: string | null): void {
  const { track } = useTelemetry();
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
