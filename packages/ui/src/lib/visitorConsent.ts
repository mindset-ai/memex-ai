// Telemetry consent gate (spec-254 dec-4 = B: opt-in).
//
// Capture is OPT-IN: nothing is minted, persisted, or sent until the visitor
// explicitly accepts. The choice lives in localStorage; Do-Not-Track / Sec-GPC is
// treated as an automatic decline (so the banner never shows and consent is never
// "granted" under DNT). This module is the single source of truth for "may we
// capture?" and deliberately imports nothing app-specific (no import cycle with
// useTelemetry, which imports FROM here).

export const CONSENT_KEY = 'memex.telemetry.consent';

export type ConsentChoice = 'granted' | 'denied';

/** Honour the browser Do-Not-Track / Global Privacy Control signal. */
export function isDoNotTrack(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { msDoNotTrack?: string; globalPrivacyControl?: boolean };
  const win =
    typeof window !== 'undefined'
      ? (window as Window & { doNotTrack?: string })
      : undefined;
  const dnt = nav.doNotTrack ?? win?.doNotTrack ?? nav.msDoNotTrack;
  return dnt === '1' || dnt === 'yes' || nav.globalPrivacyControl === true;
}

/** The recorded choice, or null when the visitor hasn't chosen yet. */
export function getConsent(): ConsentChoice | null {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(CONSENT_KEY) : null;
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

export function setConsent(choice: ConsentChoice): void {
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // localStorage unavailable (private mode) — the in-memory caller state still updates.
  }
}

/** Capture is allowed only on an explicit 'granted' AND when DNT is not set. */
export function hasConsent(): boolean {
  return !isDoNotTrack() && getConsent() === 'granted';
}

// The key AuthContext persists the session token under. Read directly (this module
// sits OUTSIDE AuthProvider — VisitorConsent is mounted app-wide in main.tsx) so the
// banner can tell an authenticated user from an anonymous one without the provider.
// Kept in lockstep with AuthContext's restoreFromStorage().
const AUTH_TOKEN_KEY = 'memex-auth-token';

/** True when a session token is persisted — i.e. the visitor is authenticated. */
export function isAuthenticatedVisitor(): boolean {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return false;
  }
}

/**
 * Show the anonymous opt-in banner only to an ANONYMOUS visitor who hasn't chosen
 * and isn't under DNT (DNT is an automatic decline, so there's nothing to ask).
 * Authenticated users are tracked by default under legitimate interest (spec-326
 * dec-1) — the opt-in banner is an anonymous-only surface and must never gate or
 * pester them; their control is the settings opt-out (TelemetryOptOut).
 */
export function shouldShowConsentBanner(): boolean {
  return !isAuthenticatedVisitor() && !isDoNotTrack() && getConsent() === null;
}
