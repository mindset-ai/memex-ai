// AcCells — spec-255: one cell per acceptance criterion, mirroring the mockup's
// "████████░░" bar. green = verified, red = failing, amber = stale, grey =
// exists-but-untested. Derived from the AcHealth COUNTS (no per-AC detail
// needed). Renders nothing when the spec has no ACs (absence is not a warning).

import type { AcHealth } from '../../api/types';

// Cap so a spec with a huge AC count doesn't blow the card width; the count
// label still reads the true totals.
const MAX_CELLS = 22;

type Cell = 'verified' | 'failing' | 'stale' | 'untested';

const CELL_CLASS: Record<Cell, string> = {
  verified: 'bg-green-500',
  failing: 'bg-rose-500',
  stale: 'bg-amber-400',
  untested: 'bg-zinc-300 dark:bg-zinc-600',
};

export function AcCells({ health }: { health: AcHealth | undefined }) {
  if (!health || health.totalActive === 0) return null;
  const { totalActive, verified, failing, stale } = health;
  const untested = Math.max(0, totalActive - verified - failing - stale);

  const cells: Cell[] = [
    ...Array<Cell>(verified).fill('verified'),
    ...Array<Cell>(failing).fill('failing'),
    ...Array<Cell>(stale).fill('stale'),
    ...Array<Cell>(untested).fill('untested'),
  ];
  const shown = cells.slice(0, MAX_CELLS);

  return (
    <div className="flex items-center gap-2" data-testid="ac-cells">
      <div
        className="flex gap-[2px]"
        role="img"
        aria-label={`${verified} of ${totalActive} acceptance criteria verified${failing ? `, ${failing} failing` : ''}`}
      >
        {shown.map((c, i) => (
          <span key={i} data-cell={c} className={`h-2 w-3 rounded-[1px] ${CELL_CLASS[c]}`} />
        ))}
      </div>
      <span className="font-mono text-[10px] tabular-nums text-muted">
        {verified}/{totalActive}
      </span>
    </div>
  );
}
