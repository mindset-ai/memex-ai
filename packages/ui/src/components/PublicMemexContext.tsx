import { createContext, useContext } from 'react';
import type { PublicMemexProbe } from '../api/client';

// spec-111 — carries the readability-probed Memex (name + visibility) down to
// components that render inside the ANONYMOUS public shell. An anonymous visitor
// has no `session.memberships`, so PageHeader can't read the Memex name or the
// public/private flag the usual way — TenantLayout provides them here instead.
// Null for authenticated users (they read membership rows directly).
const PublicMemexContext = createContext<PublicMemexProbe | null>(null);

export const PublicMemexProvider = PublicMemexContext.Provider;

/** The probed public Memex for the current anonymous view, or null when signed in. */
export function useAnonymousPublicMemex(): PublicMemexProbe | null {
  return useContext(PublicMemexContext);
}
