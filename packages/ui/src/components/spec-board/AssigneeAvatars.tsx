import { type DocSummaryAssignee } from '../../api/types';
import { Avatar } from '../ui/Avatar';

// spec-118: a person's display label for the assignee cluster.
export function personLabel(a: { name: string | null; email: string | null }): string {
  return a.name?.trim() || a.email?.trim() || 'Unknown';
}

// spec-118 ac-18: the assignee(s) shown on a board card — the live responsibility
// pointer, rendered MORE prominently than the creator. A stacked avatar cluster
// (overflow "+N"); an explicit muted "Unassigned" state when there are none.
export function AssigneeAvatars({ assignees }: { assignees?: DocSummaryAssignee[] }) {
  if (!assignees || assignees.length === 0) {
    return (
      <span
        data-testid="spec-unassigned"
        className="inline-flex items-center text-xs text-muted/70 italic"
      >
        Unassigned
      </span>
    );
  }
  const shown = assignees.slice(0, 3);
  const overflow = assignees.length - shown.length;
  return (
    <div className="flex items-center gap-1.5" data-testid="spec-assignees">
      <div className="flex -space-x-1.5">
        {shown.map((a) => (
          // spec-574: the person's one avatar; the ring separates stacked avatars.
          <Avatar key={a.userId} person={a} size="md" className="ring-1 ring-panel" />
        ))}
        {overflow > 0 && (
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-overlay border border-edge text-[10px] font-medium text-muted ring-1 ring-panel">
            +{overflow}
          </span>
        )}
      </div>
      {assignees.length === 1 && (
        <span className="text-xs text-secondary truncate max-w-32">{personLabel(shown[0]!)}</span>
      )}
    </div>
  );
}
