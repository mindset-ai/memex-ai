// spec-309 dec-2 — the `[CI n] / [Agent n]` segmented control above the emission-keys
// Active table. Picks which key type the table shows: permanent CI keys or short-lived
// agent keys. Modelled on pulse/ScopeToggle (dec-2): a two-segment radiogroup, not a
// dropdown — exactly two mutually-exclusive options, one keystroke to flip.
//
// PRESENTATIONAL. The default selection (dec-1: 'permanent'/CI) is the caller's concern;
// this control is fully driven by `value`/`onChange` and holds no state of its own.
// Arrow keys move between segments; Enter/Space selects the focused one (native <button>
// + roving aria-checked). Each segment shows its active-key count (dec-3).

export type KeyTypeFilter = 'permanent' | 'ephemeral';

export interface EmissionKeyTypeToggleProps {
  /** Currently selected key type. */
  value: KeyTypeFilter;
  /** Fired when the user picks a different type. */
  onChange: (value: KeyTypeFilter) => void;
  /** Active-key counts per type, rendered alongside each segment label (dec-3). */
  counts: Record<KeyTypeFilter, number>;
}

const OPTIONS: { value: KeyTypeFilter; label: string }[] = [
  { value: 'permanent', label: 'CI' },
  { value: 'ephemeral', label: 'Agent' },
];

export function EmissionKeyTypeToggle({ value, onChange, counts }: EmissionKeyTypeToggleProps) {
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
      aria-label="Emission key type"
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
            // Selected segment uses bg-edge-strong (slate-300 / #4b525f) — a clearly
            // visible grey against the lighter toggle container, in both themes. The
            // near-invisible white/overlay default read as "nothing selected".
            className={`rounded-full px-2.5 py-0.5 font-medium transition-colors focus:outline-hidden focus-visible:ring-1 focus-visible:ring-edge-strong ${
              selected
                ? 'bg-edge-strong text-primary shadow-xs'
                : 'text-muted hover:text-primary'
            }`}
          >
            {opt.label}{' '}
            <span className={selected ? 'text-secondary' : 'text-muted'}>{counts[opt.value]}</span>
          </button>
        );
      })}
    </div>
  );
}
