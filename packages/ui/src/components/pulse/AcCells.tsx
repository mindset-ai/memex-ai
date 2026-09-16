// AcCells — spec-255: the AC-health bar on a Hot Spec card. A single CONTINUOUS
// full-width bar filled PROPORTIONALLY (not one segment per AC — the count is
// unbounded). Three states only:
//   green  = ACs whose tests pass (verified; stale counts here — it did pass)
//   red    = ACs whose tests fail
//   yellow = ACs that exist but have NO tests yet (untested)
// No bar at all = the spec has no ACs.

import type { AcHealth } from '../../api/types';
// spec-566 dec-2 — one rendering decision for the superseded count.
import { coverageAnnotationLabels } from '@memex/shared';

export function AcCells({ health }: { health: AcHealth | undefined }) {
  // spec-566 ac-11 — this is the component that renders HotSpecs' number
  // (`{passing}/{totalActive}`), so the count lands here rather than in
  // HotSpecs itself, which only passes `health` down.
  const annotations = coverageAnnotationLabels({
    superseded: health?.superseded ?? 0,
    overrides: health?.overrides ?? 0,
  });
  const supersededLabel = annotations.length ? annotations.join(' · ') : null;
  if (!health || health.totalActive === 0) {
    // No live criteria, but some were retired: say so instead of rendering
    // nothing, which would read as a Spec that never committed to anything.
    if (!supersededLabel) return null;
    return (
      <div className="flex items-center gap-2" data-testid="ac-cells">
        <span
          data-testid="ac-cells-superseded"
          className="shrink-0 font-mono text-[10px] tabular-nums text-muted"
        >
          {supersededLabel}
        </span>
      </div>
    );
  }
  const { totalActive, verified, failing, stale } = health;
  const passing = verified + stale; // stale tests did pass, just aged → green
  const untested = Math.max(0, totalActive - passing - failing);
  const pct = (n: number) => `${(n / totalActive) * 100}%`;

  return (
    <div className="flex items-center gap-2" data-testid="ac-cells">
      {/* One continuous bar; coloured regions are proportional widths. */}
      <div
        className="flex flex-1 h-2 rounded-xs overflow-hidden"
        role="img"
        aria-label={`${passing} of ${totalActive} acceptance criteria passing${failing ? `, ${failing} failing` : ''}${untested ? `, ${untested} untested` : ''}${supersededLabel ? `, ${supersededLabel}` : ''}`}
      >
        {passing > 0 && <span data-cell="verified" className="h-full bg-green-500" style={{ width: pct(passing) }} />}
        {failing > 0 && <span data-cell="failing" className="h-full bg-rose-500" style={{ width: pct(failing) }} />}
        {untested > 0 && <span data-cell="untested" className="h-full bg-amber-400" style={{ width: pct(untested) }} />}
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
        {passing}/{totalActive}
        {supersededLabel && (
          <span data-testid="ac-cells-superseded"> · {supersededLabel}</span>
        )}
      </span>
    </div>
  );
}
