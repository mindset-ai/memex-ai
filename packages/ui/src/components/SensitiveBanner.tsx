// spec-535 dec-4 — the warning surface, near the title.
//
// The SETTER is a byline pill (BylineSensitive); this is the SIGNAL, and the two
// are deliberately different surfaces. Not because the byline is full — for a
// Spec it carries four items and six at most — but because of what that row IS:
// small, grey, neutral metadata. A danger signal in that costume is camouflaged
// by it, which is the visual form of the failure spec-240 dec-1 recorded when a
// weak model skimmed past a non-blocking warning. dec-3 refused the same
// flattening on the MCP side (a distinct block, never another `Key: value` line),
// and one product should not make opposite calls about one signal.
//
// Visible to EVERYONE, unlike the setter. A reader without write access is
// exactly the person who most needs to know to ask first, so only the control is
// gated — never the warning.
//
// Shape follows SupersededByBanner (spec-521): same near-title slot, same
// rounded-panel treatment, `role="status"` rather than `alert` because this is
// advisory and interrupts nobody.

export function SensitiveBanner({ contactName }: { contactName: string | null }) {
  return (
    <div
      role="status"
      data-testid="sensitive-banner"
      className="mb-4 rounded-lg border border-status-warning-border bg-status-warning-bg px-4 py-3 flex items-start gap-3"
    >
      <span aria-hidden="true" className="text-status-warning-text mt-0.5 shrink-0">
        ⚠
      </span>
      <p className="text-sm text-primary">
        {/* The word "Sensitive" is in the TEXT, not only in the colour. Strip
            every class and the meaning survives — which is the actual promise
            behind "does not depend on colour alone", where a coloured border
            alone conveys nothing to someone who cannot see it. */}
        <span className="font-medium text-heading">Sensitive — </span>
        {contactName ? (
          <>
            delicate or complex. Contact{' '}
            <span className="font-medium text-heading">{contactName}</span> before you
            change anything here.
          </>
        ) : (
          // Provenance can be absent (an unattributed write). Still warn: going
          // silent here would drop the signal exactly when attribution failed.
          <>delicate or complex. Ask the org before you change anything here.</>
        )}{' '}
        {/* ac-3 is a promise the reader has to be able to act on. Without this
            line the honest reading of a warning banner is "do not proceed",
            which is the opposite of what this flag means. */}
        <span className="text-secondary">
          This is advisory: it blocks nothing, and every action still works.
        </span>
      </p>
    </div>
  );
}
