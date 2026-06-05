// AcPill — a single clickable + tooltip-on-hover pill that represents one
// AC in a compact list. Used by the wall-of-pills in AcPanel (verified
// section) and by the per-Decision DecisionAcStrip.
//
// Behaviour:
//   - hover         → floating tooltip with statement, kind, state, test
//                     summary, last run time
//   - click         → onJumpToAc(ac.id) — caller switches to the AC tab
//                     and scrolls/highlights the target row
//
// Shared component so both surfaces speak the same visual language; if the
// palette or hover affordance changes, change it once here.

import { useRef, useState } from 'react';
import type {
  AcWithVerification,
  AcVerificationState,
} from '../api/client';

interface AcPillProps {
  row: AcWithVerification;
  /** What happens when the user clicks the pill. Caller decides — on the
   *  Decisions strip this jumps to the AC tab; on the AC tab itself this
   *  expands the inline statement card. */
  onClick?: () => void;
  /** Optional one-liner shown at the bottom of the hover tooltip,
   *  describing what `onClick` will do. */
  clickHint?: string;
}

// Palette deliberately kept warm, not strident. Failing uses rose-500
// (softer than red-500 — recognisably "broken" without the glare of
// danger-red). Untested + stale stay quiet but distinct from each other.
const STATE_DOT: Record<AcVerificationState, string> = {
  verified: 'bg-green-500',
  failing: 'bg-rose-500',
  untested: 'bg-zinc-300',
  stale: 'bg-amber-400',
};

const STATE_PILL: Record<AcVerificationState, string> = {
  verified: 'bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20',
  failing: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 hover:bg-rose-500/25',
  untested: 'bg-zinc-400/10 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-400/20',
  stale: 'bg-amber-400/10 text-amber-700 dark:text-amber-400 hover:bg-amber-400/20',
};

const STATE_LABEL: Record<AcVerificationState, string> = {
  verified: 'verified',
  failing: 'failing',
  untested: 'untested',
  stale: 'stale',
};

function relativeTime(d: Date | null): string {
  if (!d) return 'never';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function AcPill({ row, onClick, clickHint }: AcPillProps) {
  const [hover, setHover] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);

  const passing = row.tests.filter((t) => t.latestStatus === 'pass').length;
  const failingCount = row.tests.filter(
    (t) => t.latestStatus === 'fail' || t.latestStatus === 'error',
  ).length;
  const latestRunAt = row.tests.reduce<Date | null>((acc, t) => {
    const at = new Date(t.latestRunAt);
    return acc === null || at > acc ? at : acc;
  }, null);

  return (
    <span className="relative inline-block">
      <button
        ref={pillRef}
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-mono transition-colors ${onClick ? 'cursor-pointer' : 'cursor-default'} ${STATE_PILL[row.verificationState]}`}
      >
        <span
          className={`inline-block h-1.5 w-1.5 rounded-sm ${STATE_DOT[row.verificationState]}`}
        />
        ac-{row.ac.seq}
      </button>
      {hover && (
        <div
          className="absolute z-50 left-0 top-full mt-1 w-72 rounded-md bg-zinc-900 text-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 text-xs p-2.5 shadow-lg pointer-events-none"
          role="tooltip"
        >
          <div className="flex items-center gap-1.5 mb-1 opacity-80">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-sm ${STATE_DOT[row.verificationState]}`}
            />
            <span className="font-mono">ac-{row.ac.seq}</span>
            <span className="opacity-60">·</span>
            <span>{row.ac.kind}</span>
            <span className="opacity-60">·</span>
            <span>{STATE_LABEL[row.verificationState]}</span>
          </div>
          <div className="font-medium leading-snug mb-2">
            {row.ac.statement}
          </div>
          {row.tests.length === 0 ? (
            <div className="opacity-70 italic">
              No test in the codebase asserts this yet.
            </div>
          ) : (
            <div className="opacity-80 space-y-0.5">
              <div>
                {row.tests.length} test{row.tests.length === 1 ? '' : 's'} ·{' '}
                {passing} passing{failingCount > 0 && ` · ${failingCount} failing`}
              </div>
              {latestRunAt && <div>last run {relativeTime(latestRunAt)}</div>}
              {row.daysSinceLastRun !== null && row.daysSinceLastRun > 7 && (
                <div>stale: {row.daysSinceLastRun}d since last run</div>
              )}
            </div>
          )}
          {clickHint && onClick && (
            <div className="mt-2 pt-2 border-t border-zinc-700 dark:border-zinc-300 opacity-70 text-[10px]">
              {clickHint}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
