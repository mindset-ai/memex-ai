import { useTelemetry } from '../hooks/useTelemetry';

// The consent / opt-out control (spec-244 §Consent and control). Lets a user turn
// off product-usage capture. Do-Not-Track is honoured independently and always.
// The copy states the privacy posture plainly: no content, no keystrokes, a public
// registry — transparency is the guarantee.
export function TelemetryOptOut() {
  const { optedOut, setOptOut } = useTelemetry();
  return (
    <section className="space-y-3" data-testid="telemetry-optout">
      <div>
        <h2 className="text-base font-semibold text-heading">Product-usage analytics</h2>
        <p className="text-sm text-secondary mt-1">
          Memex records anonymous product-usage events (which value paths you walk) to improve
          the product. Events carry no document content, message text, or keystrokes — only IDs,
          enums, and counts, and the full list is public in the event registry. You can opt out
          here; Do-Not-Track is always honoured.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!optedOut}
            onChange={(e) => setOptOut(!e.target.checked)}
            className="h-4 w-4"
            data-testid="telemetry-toggle"
          />
          <span className="text-sm text-primary">
            {optedOut ? 'Usage analytics off' : 'Share anonymous usage analytics'}
          </span>
        </label>
      </div>
    </section>
  );
}
