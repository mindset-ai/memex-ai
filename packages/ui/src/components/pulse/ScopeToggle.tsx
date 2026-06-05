// ScopeToggle — the `[Just me ▾] / [Everyone]` segmented control in the Pulse
// header (b-60, dec-7). Picks whose activity the feed shows: just the current
// user ('me') or every actor in the Memex ('everyone').
//
// PRESENTATIONAL. The default selection (dec-7: 'me') is the page's concern —
// this control is fully driven by `value`/`onChange`, holds no state of its own,
// and never touches the router.
//
// Rendered as a two-segment radiogroup (not a dropdown): there are exactly two
// mutually-exclusive options, so a segmented toggle reads faster and is one
// keystroke to flip. Arrow keys move between segments; Enter/Space selects the
// focused one (native <button> + roving aria-checked).

export type PulseScope = 'me' | 'everyone';

export interface ScopeToggleProps {
  /** Currently selected scope. */
  value: PulseScope;
  /** Fired when the user picks a different scope. */
  onChange: (value: PulseScope) => void;
}

const OPTIONS: { value: PulseScope; label: string }[] = [
  { value: 'me', label: 'Just me' },
  { value: 'everyone', label: 'Everyone' },
];

export function ScopeToggle({ value, onChange }: ScopeToggleProps) {
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const idx = OPTIONS.findIndex((o) => o.value === value);
    const nextIdx =
      e.key === 'ArrowRight'
        ? Math.min(idx + 1, OPTIONS.length - 1)
        : Math.max(idx - 1, 0);
    const next = OPTIONS[nextIdx];
    if (next && next.value !== value) onChange(next.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Activity scope"
      onKeyDown={onKeyDown}
      className="inline-flex items-center rounded-full border border-edge bg-input p-0.5 text-xs"
    >
      {OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            // Only the selected segment is a tab stop; arrow keys move within.
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(opt.value);
            }}
            className={`rounded-full px-2.5 py-0.5 font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-edge-strong ${
              selected
                ? 'bg-overlay text-primary shadow-sm'
                : 'text-muted hover:text-primary'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
