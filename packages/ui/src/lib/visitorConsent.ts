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

/** Show the banner only when the visitor hasn't chosen and DNT isn't set (DNT is
 *  an automatic decline, so there's nothing to ask). */
export function shouldShowConsentBanner(): boolean {
  return !isDoNotTrack() && getConsent() === null;
}
