import { useEffect, useState } from 'react';
import { resolveTenantRedirectApi } from '../api/client';

// spec-479 dec-5 — when TenantLayout can't resolve the URL's tenant (a memex
// whose slug was renamed), ask the server whether the path forwards, so the SPA
// can navigate there instead of bouncing to /login (anonymous) or the default
// landing (authed non-member).
//
// Fires ONLY when `enabled` (i.e. we're already on a resolution miss and about
// to bounce) — never on a normal successful load. While the lookup is in
// flight the caller should render nothing (avoid flashing the bounce); on a hit
// it navigates to `to`; on a miss/error it falls through to the normal bounce.
export type StaleForward =
  | { state: 'idle'; to: null }
  | { state: 'loading'; to: null }
  | { state: 'done'; to: string | null };

export function useStaleTenantForward(pathname: string, enabled: boolean): StaleForward {
  // undefined = not yet resolved this cycle; null = miss; string = hit.
  const [to, setTo] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      setTo(undefined);
      return;
    }
    let cancelled = false;
    setTo(undefined);
    resolveTenantRedirectApi(pathname)
      .then((result) => {
        if (!cancelled) setTo(result);
      })
      .catch(() => {
        if (!cancelled) setTo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, enabled]);

  if (!enabled) return { state: 'idle', to: null };
  if (to === undefined) return { state: 'loading', to: null };
  return { state: 'done', to: typeof to === 'string' ? to : null };
}
