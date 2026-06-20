import { useEffect, useState } from 'react';
import { getConsent, setConsent, shouldShowConsentBanner } from '../lib/visitorConsent';
import { resolveVisitorIdWithConsent, clearVisitorId } from '../lib/visitorId';

// The opt-in consent banner + the consent-gated visitor_id mint (spec-254 t-3,
// dec-4 = B). Mounted once, app-wide (pre-auth included). Shown only to a visitor
// who hasn't chosen and isn't under Do-Not-Track (DNT is an automatic decline, so
// there's nothing to ask).
//
//   Accept  → record consent + mint/persist the visitor_id (cookie + localStorage)
//   Decline → record the decline + clear any durable id
//
// NOTE: emitting `visitor.first_seen` is deferred to the spec-244 anonymous-capture
// retrofit — pre-auth that event no-ops (no resolved tenant + the server no-ops
// anonymous callers), so it would land nothing today. The MINT here is what the
// identify merge (t-4) consumes at sign-in; the first_seen event rides the retrofit.
export function VisitorConsent() {
  const [show, setShow] = useState<boolean>(() => shouldShowConsentBanner());

  // Consent already granted on a prior visit → resolve/persist the id on load.
  useEffect(() => {
    if (getConsent() === 'granted') resolveVisitorIdWithConsent();
  }, []);

  if (!show) return null;

  const accept = (): void => {
    setConsent('granted');
    resolveVisitorIdWithConsent();
    setShow(false);
  };
  const decline = (): void => {
    setConsent('denied');
    clearVisitorId();
    setShow(false);
  };

  return (
    <div
      role="dialog"
      aria-label="Analytics consent"
      data-testid="visitor-consent"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-xl rounded-lg border border-default bg-surface p-4 shadow-lg"
    >
      <p className="text-sm text-secondary">
        Memex records anonymous product-usage events to understand how people use the product.
        Events carry no document content, message text, or keystrokes — only IDs, enums, and
        counts, and the full list is public in the event registry. May we?
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={decline}
          data-testid="visitor-consent-decline"
          className="rounded-md px-3 py-1.5 text-sm text-secondary hover:text-primary"
        >
          Decline
        </button>
        <button
          type="button"
          onClick={accept}
          data-testid="visitor-consent-accept"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
        >
          Accept
        </button>
      </div>
    </div>
  );
}
