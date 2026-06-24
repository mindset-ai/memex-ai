import { type DocSummaryAssignee } from '../../api/types';

// spec-118: a person's display label + initials for the assignee avatar.
export function personLabel(a: { name: string | null; email: string | null }): string {
  return a.name?.trim() || a.email?.trim() || 'Unknown';
}
export function initials(label: string): string {
  const parts = label.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
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
        {shown.map((a) => {
          const label = personLabel(a);
          return (
            <span
              key={a.userId}
              title={label}
              className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-overlay border border-edge text-[10px] font-medium text-heading ring-1 ring-panel"
            >
              {initials(label)}
            </span>
          );
        })}
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
