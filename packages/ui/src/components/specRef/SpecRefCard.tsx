import type { DocSummary } from '../../api/types';
import { Badge } from '../ui';

/**
 * spec-529 t-5 — the card behind a reference pill.
 *
 * Renders entirely from the page's already-resolved status set: opening it
 * issues no request. Nothing inside is interactive, which keeps the
 * focus-management problem small — the pill itself is the link.
 *
 * The acceptance-criteria line is the one that needs care. "Untested" is an
 * ABSENCE of signal, not a failure, which is the distinction `acHealth` already
 * draws between `covered` and `totalActive`. A Spec with no criteria at all must
 * therefore read as "no commitments yet" and never as 0% complete — those are
 * different states and conflating them would make the card lie about the Spec
 * that has committed to nothing.
 */

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Whole days between then and now, floored. */
function daysSince(iso: string): number | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

export function SpecRefCard({ id, doc }: { id: string; doc: DocSummary }) {
  const progress = doc.taskProgress;
  const health = doc.acHealth;
  const inPhase = daysSince(doc.statusChangedAt);

  return (
    <span
      id={id}
      role="tooltip"
      data-testid="spec-ref-card"
      className="absolute left-0 top-full z-50 mt-1 block w-80 cursor-default rounded-md border border-subtle bg-panel p-3 text-left shadow-lg"
    >
      <span className="block text-sm font-semibold text-heading">{doc.title}</span>

      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-secondary">
        <span className="font-mono">{doc.handle}</span>
        <Badge status={doc.status} />
        {inPhase !== null && (
          <span>
            {inPhase === 0 ? 'today' : `${inPhase}d in ${doc.status.replace(/_/g, ' ')}`}
          </span>
        )}
      </span>

      {/* Archived and superseded must be unmissable: a reference to a replaced
          Spec that reads as live is worse than no pill at all. */}
      {doc.archivedAt && (
        <span
          data-testid="spec-ref-archived"
          className="mt-2 block rounded-sm border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning"
        >
          Archived{doc.archiveReason ? ` — ${doc.archiveReason}` : ''}
        </span>
      )}
      {doc.supersededByDocId && (
        <span
          data-testid="spec-ref-superseded"
          className="mt-2 block rounded-sm border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning"
        >
          Superseded{doc.supersessionNote ? ` — ${doc.supersessionNote}` : ''}
        </span>
      )}

      <span className="mt-2 block text-[11px] text-primary">
        {progress ? (
          <span data-testid="spec-ref-tasks">
            {progress.complete} of {progress.total} tasks complete
            {progress.inProgress > 0 && `, ${progress.inProgress} in progress`}
            {progress.notStarted > 0 && `, ${progress.notStarted} not started`}
          </span>
        ) : (
          <span data-testid="spec-ref-tasks">No tasks yet</span>
        )}
      </span>

      <span className="mt-1 block text-[11px] text-primary">
        {health && health.totalActive > 0 ? (
          <span data-testid="spec-ref-acs">
            {Math.round((health.verified / health.totalActive) * 100)}% of{' '}
            {health.totalActive} acceptance criteria verified
            {health.failing > 0 && `, ${health.failing} failing`}
            {/* Untested is reported as what it is — nothing has been asserted yet
                — never folded in with failures. */}
            {health.untested > 0 && `, ${health.untested} untested`}
          </span>
        ) : (
          <span data-testid="spec-ref-acs">No acceptance criteria yet</span>
        )}
      </span>

      {doc.lastActivity && (
        <span
          data-testid="spec-ref-activity"
          className="mt-2 block border-t border-subtle pt-2 text-[11px] text-muted"
        >
          {/* WHAT changed and WHEN — never WHO. This card is read by anonymous
              visitors on public Memexes, and actor identity is PII. */}
          {doc.lastActivity.narrative} · {formatDate(doc.lastActivity.at)}
        </span>
      )}
    </span>
  );
}
