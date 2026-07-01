// spec-151 — the per-clause verification mark on a Standard. A clause's green means a
// tagged test reported pass (the honest ceiling; no CI/spot/verifier distinction):
//   passing  → green dot with a white check
//   failing  → red dot with a white cross
//   untested → grey blob
//   non-testable clause → no mark at all (a fixed-width spacer keeps text aligned)

import type { ClauseCoverageState } from '../api/clause-coverage';

const TITLE: Record<ClauseCoverageState, string> = {
  passing: 'Passing: a test tagged to this clause reports it holds',
  failing: 'Failing: a test tagged to this clause reports it is violated',
  untested: 'Untested: no test is tagged to this clause yet',
};

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 6.5 5 9l4.5-5.5" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M3.5 3.5 8.5 8.5M8.5 3.5 3.5 8.5" />
    </svg>
  );
}

export function ClauseStatusDot({
  state,
  countable,
}: {
  state: ClauseCoverageState;
  countable: boolean;
}): React.JSX.Element {
  // A non-testable / "not a real" clause carries no mark. The spacer preserves the
  // left margin so testable and non-testable clause text align in one column.
  if (!countable) {
    return (
      <span
        data-testid="clause-status"
        data-state="none"
        className="inline-block w-4 h-4 shrink-0"
        aria-hidden
      />
    );
  }

  const base = 'inline-flex items-center justify-center w-4 h-4 shrink-0 rounded-full';
  const byState: Record<ClauseCoverageState, { className: string; icon: React.JSX.Element | null }> = {
    passing: { className: 'bg-emerald-500 text-white', icon: <CheckIcon /> },
    failing: { className: 'bg-rose-500 text-white', icon: <CrossIcon /> },
    untested: { className: 'bg-zinc-300 dark:bg-zinc-600', icon: null },
  };
  const meta = byState[state];
  return (
    <span
      data-testid="clause-status"
      data-state={state}
      title={TITLE[state]}
      className={`${base} ${meta.className}`}
    >
      {meta.icon}
    </span>
  );
}
