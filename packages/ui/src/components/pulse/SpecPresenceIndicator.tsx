// SpecPresenceIndicator — the AMBIENT presence chip on a spec / AC surface
// (spec-122 ac-5). The same presence signal Pulse shows, surfaced where the work
// happens: a small live dot + who's here, so a human on the AC tab sees
// "● Claude Code is working this — ACs may shift" without opening Pulse.
//
// PRESENTATIONAL. The present rows arrive via props; DocDocument owns the poll
// (usePresence) and the heartbeat (usePresenceHeartbeat). Renders nothing when
// no one is present, so it stays out of the way on a quiet spec.

import { LiveDot } from './LiveDot';
import { clientLabel } from './clientLabel';
import type { PresentRow } from './types';

export interface SpecPresenceIndicatorProps {
  /** Everyone "here" on this spec right now. */
  present: PresentRow[];
  /**
   * An AC-surface variant adds the "ACs may shift" caveat — presence on the AC
   * tab is a heads-up that verification state is in flux.
   */
  variant?: 'spec' | 'ac';
  className?: string;
}

function name(row: PresentRow): string {
  if (row.actorName) return row.actorName;
  if (row.clientId) return clientLabel(row.channel, row.clientId);
  return 'Someone';
}

export function SpecPresenceIndicator({
  present,
  variant = 'spec',
  className = '',
}: SpecPresenceIndicatorProps) {
  if (present.length === 0) return null;

  // Lead with the most-recent worker by name; collapse the rest to a count.
  const lead = present[0];
  const others = present.length - 1;
  const isWorking = present.some((p) => p.actorKind !== 'human') || variant === 'ac';

  return (
    <span
      data-testid="spec-presence-indicator"
      data-count={present.length}
      className={`inline-flex items-center gap-1.5 rounded-full border border-edge-subtle bg-surface/60 px-2 py-0.5 text-xs text-secondary ${className}`}
      title={present.map(name).join(', ')}
    >
      <LiveDot live size="sm" />
      <span className="text-primary font-medium">{name(lead)}</span>
      {others > 0 ? (
        <span className="text-muted">
          +{others} {others === 1 ? 'other' : 'others'}
        </span>
      ) : null}
      <span className="text-muted">
        {others > 0 ? 'are' : 'is'} working this
        {variant === 'ac' && isWorking ? ' — ACs may shift' : ''}
      </span>
    </span>
  );
}
