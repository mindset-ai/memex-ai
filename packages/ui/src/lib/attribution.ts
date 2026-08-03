export interface AttributionData {
  gclid?: string;
  li_fat_id?: string;
  oppref?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

export function readAttributionCookie(): AttributionData | null {
  try {
    const m = document.cookie.match(/(?:^|; )_memex_attribution=([^;]*)/);
    if (!m) return null;
    return JSON.parse(decodeURIComponent(m[1])) as AttributionData;
  } catch {
    return null;
  }
}

export function pushDataLayer(event: Record<string, unknown>): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    w.dataLayer = w.dataLayer ?? [];
    (w.dataLayer as unknown[]).push(event);
  } catch {
    // never throw from analytics
  }
}

// Internal / test accounts must produce no conversion anywhere downstream
// (spec-517 ac-7), matching the server-side "real users" exclusion already
// enforced in packages/server/src/services/conversion-apis.ts (spec-505). Both
// sides key on the mindset.ai email domain so the client pixels and the server
// conversion APIs agree on who counts as internal.
function isInternalEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  return email.slice(at + 1).trim().toLowerCase() === 'mindset.ai';
}

// Fires the sign-up conversion across every channel for a newly created account.
// Called once, on first authenticated landing of a new user (spec-517 dec-1):
//   - dataLayer push → GTM forwards to Google Ads + LinkedIn (unchanged).
//   - gtag event     → GA4 key event `sign_up_completed` (GA4 is hardcoded, not in GTM).
//   - oaiq track     → OpenAI `registration_completed`.
// Analytics must never break the auth flow, so every send is guarded and can't
// throw. A missing tag is LOGGED rather than silently skipped, so an absent or
// ad-blocked tag can't masquerade as zero conversions (spec-517 ac-5).
export function fireSignupConversion(
  eventId: string,
  email: string | null | undefined,
  attribution: AttributionData | null,
): void {
  // spec-517 ac-7 — internal / test sign-ups fire nothing on any channel.
  if (isInternalEmail(email)) return;

  const attr = attribution ?? {};
  const w = window as unknown as {
    gtag?: (...args: unknown[]) => void;
    oaiq?: (...args: unknown[]) => void;
  };

  // GTM → Google Ads + LinkedIn (unchanged from the original dataLayer push).
  pushDataLayer({ event: 'sign_up_completed', event_id: eventId, ...attr });

  // GA4 key event (hardcoded gtag from index.html).
  try {
    if (typeof w.gtag === 'function') {
      w.gtag('event', 'sign_up_completed', { event_id: eventId, ...attr });
    } else {
      console.warn('[spec-517] GA4 gtag not loaded — sign_up_completed not sent to GA4');
    }
  } catch {
    // never throw from analytics
  }

  // OpenAI advertising pixel (hardcoded oaiq from index.html).
  try {
    if (typeof w.oaiq === 'function') {
      w.oaiq('track', 'registration_completed', { event_id: eventId });
    } else {
      console.warn('[spec-517] OpenAI pixel (oaiq) not loaded — registration_completed not sent');
    }
  } catch {
    // never throw from analytics
  }
}
