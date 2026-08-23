// spec-535 dec-4 — the sensitivity SETTER, on the Spec byline.
//
// The requirement asked for the flag to be settable from the top bar, on the row
// that already carries the assign and tag affordances. That is what this is. The
// WARNING is a separate surface (SensitiveBanner, near the title) because every
// item on this row is small, grey, neutral metadata, and a danger signal wearing
// that costume is camouflaged by it — the visual form of the failure spec-240
// dec-1 recorded. dec-3 made the same call on the MCP side; making the opposite
// one here would be the product contradicting itself about one signal.
//
// No person-picker, deliberately: whoever flags it becomes the contact (dec-2),
// which is what let this Spec ship without creating the fourth "who" concept
// spec-506 dec-4 has an open question about. One click, no confirmation dialog —
// matching the frictionless posture of "Assign me" and the posture switch.
//
// State is OWNED BY THE PAGE and passed in. The control reports upward via
// onChange rather than holding a second copy: the banner (t-7) reads the same
// document, and two independent copies of one flag is how they drift apart.

import { useCallback, useState } from 'react';
import { setDocSensitive, clearDocSensitive } from '../api/client';
import { useMemexAccess } from '../hooks/useMemexAccess';

export function BylineSensitive({
  docId,
  sensitive,
  onChange,
}: {
  docId: string;
  sensitive: boolean;
  onChange: () => void;
}) {
  const { canWrite } = useMemexAccess();
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      if (sensitive) {
        await clearDocSensitive(docId);
      } else {
        await setDocSensitive(docId);
      }
      onChange();
    } catch {
      // Swallowed on purpose. This flag blocks nothing by design (ac-3), so its
      // own control must not become the thing that blocks: a failed write leaves
      // the button usable and the page unchanged, and the next read shows the
      // real state.
    } finally {
      setBusy(false);
    }
  }, [docId, sensitive, onChange]);

  // Read-only visitors see NOTHING here — not a disabled control. The byline
  // separators are gated on each item existing, so rendering an empty node would
  // leave an orphan `·`. They still see the banner: only the control is gated,
  // never the warning.
  if (!canWrite) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={sensitive}
      aria-label={sensitive ? 'Clear the sensitive flag' : 'Flag as sensitive'}
      title={
        sensitive
          ? 'Clear the sensitive flag'
          : 'Flag as sensitive — asks people to contact you before changing it. Blocks nothing.'
      }
      className={
        'inline-flex h-6 items-center px-2 rounded-full border text-[11px] font-medium leading-none disabled:opacity-50 ' +
        (sensitive
          ? 'border-status-warning-border text-status-warning-text bg-status-warning-bg hover:opacity-80'
          : 'border-edge text-secondary hover:text-primary hover:bg-overlay')
      }
    >
      {sensitive ? 'Sensitive ✕' : '+ Sensitive'}
    </button>
  );
}
