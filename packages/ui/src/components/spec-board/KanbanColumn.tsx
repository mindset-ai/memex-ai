import { type DragEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { type DocSummary } from '../../api/types';
import { statusTextClass } from '../../utils/statusStyles';
import { formatDate, docSeq } from '../../utils/format';
import { CodeGroundedBadge } from '../CodeGroundedBadge';
import { SpecMenu, type SpecMenuItem } from '../SpecMenu';
import { TagChip } from '../TagChip';
import { tenantPath } from '../../utils/tenantUrl';
import { useTelemetry } from '../../hooks/useTelemetry';
import {
  borderClassForHealth,
  SpecHealthChip,
  SpecHealthStrip,
} from '../SpecHealthIndicator';
import { AssigneeAvatars } from './AssigneeAvatars';
import { type SpecKanbanStatus } from './types';

export interface KanbanColumnProps {
  id: SpecKanbanStatus;
  label: string;
  docs: DocSummary[];
  docsById: Map<string, DocSummary>;
  isOver: boolean;
  draggingId: string | null;
  buildMenuItems: (doc: DocSummary) => SpecMenuItem[];
  // spec-111 t-8: when false (non-member read-only view), every edit/create
  // control in the column is suppressed — no add-card, no per-card menu, no
  // drag-to-change-status.
  canWrite: boolean;
  onDragStart: (e: DragEvent<HTMLElement>, docId: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>, column: SpecKanbanStatus) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLElement>, column: SpecKanbanStatus) => void;
  className?: string;
  headerExtra?: ReactNode;
  // Renders the "+ Add spec" pinned card at the top of the column when set.
  // Click invokes the same NewSpecModal as the page-header button.
  onAddSpec?: () => void;
}

export function KanbanColumn(props: KanbanColumnProps) {
  const { track } = useTelemetry(true);
  const {
    id,
    label,
    docs,
    docsById,
    isOver,
    draggingId,
    buildMenuItems,
    canWrite,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
    className = '',
    headerExtra,
    onAddSpec,
  } = props;
  return (
    <div
      onDragOver={(e) => onDragOver(e, id)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, id)}
      className={`flex flex-col min-h-0 rounded-lg border transition-colors ${className} ${
        isOver ? 'border-edge-strong bg-overlay' : 'border-edge-subtle bg-surface/40'
      }`}
    >
      <div className="flex-none px-3 py-2.5 border-b border-edge-subtle flex items-center justify-between gap-2">
        <h2 className={`text-xs font-medium uppercase tracking-wider ${statusTextClass(id)}`}>
          {label}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted tabular-nums">{docs.length}</span>
          {headerExtra}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {canWrite && onAddSpec && (
          <button
            type="button"
            onClick={onAddSpec}
            className="w-full flex flex-col items-center justify-center gap-1.5 px-3 py-6 rounded-md border-2 border-dashed border-edge-subtle text-secondary hover:text-primary hover:border-edge-strong hover:bg-card-hover/40 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            <span className="text-sm">Add spec</span>
          </button>
        )}
        {docs.map((d) => {
          const inListParent = d.parentDocId ? docsById.get(d.parentDocId) : null;
          const parent = inListParent ?? d.parent ?? null;
          // b-66: per-card AC-health treatment. `acHealth` is populated by the
          // server-side aggregator behind `?include=acHealth`; undefined means
          // either the request omitted the include flag, or the Spec has zero
          // active ACs. Both collapse to "no commitments" — no border, no
          // chip, no strip (b-66 Scope AC-4).
          const healthBorder = borderClassForHealth(d.acHealth);
          return (
            // spec-521 t-4: `spec-card` gives the e2e journeys a stable handle on one
            // card (the archive journey has to open THIS card's overflow menu), rather
            // than reaching through brittle class selectors.
            <div key={d.id} data-testid="spec-card" className="relative group">
              <Link
                to={tenantPath(`/specs/${d.handle}`)}
                draggable={canWrite}
                onClick={() =>
                  track('spec.card_opened', {
                    specSeq: docSeq(d.handle) ?? d.handle,
                    phase: id,
                    assigned: (d.assignees?.length ?? 0) > 0,
                    ...(d.assignees?.[0]?.userId
                      ? { assignedUserId: d.assignees[0].userId }
                      : {}),
                  })
                }
                onDragStart={canWrite ? (e) => onDragStart(e, d.id) : undefined}
                onDragEnd={canWrite ? onDragEnd : undefined}
                className={`block border rounded-md p-3 transition-all bg-panel border-edge-subtle hover:border-edge hover:bg-card-hover ${
                  draggingId === d.id ? 'opacity-40' : ''
                } ${healthBorder}`}
              >
                {/* pr-9 only on the title row — clears the absolute top-right
                    hover menu without indenting the footer (so the grounded
                    name + seal can sit flush to the card's right edge). */}
                <div className="flex items-start gap-2 mb-2 pr-6">
                  <h3 className="flex-1 text-sm font-medium text-heading leading-snug">
                    {docSeq(d.handle) && (
                      <span className="text-muted font-normal mr-1">{docSeq(d.handle)}.</span>
                    )}
                    {d.title}
                  </h3>
                </div>
                {d.parentDocId && (
                  <div
                    className="text-xs text-muted italic mb-1"
                    data-testid="spec-parent"
                  >
                    {parent
                      ? parent.docType === 'spec'
                        ? `Promoted from ${parent.title}`
                        : `Promoted from: ${parent.title} (${parent.docType})`
                      : `Promoted from ${d.parentDocId}`}
                  </div>
                )}
                <div className="flex items-end justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {/* spec-118 ac-18: assignee(s) lead the card — more prominent
                        than the creator, which drops to a smaller secondary line. */}
                    <AssigneeAvatars assignees={d.assignees} />
                    <div className="text-[11px] text-muted truncate mt-1">
                      {formatDate(d.createdAt)} · {d.creator?.name?.trim() || d.creator?.email?.trim() || 'Unknown'}
                    </div>
                  </div>
                  {/* spec-409 (ac-1): compact code-grounded seal lives on the
                      roomy bottom-right footer (beside the health chip) so it
                      never eats the title line. Renders only for a grounded Spec
                      (null otherwise); stale tint when a decision/AC changed
                      since grounding. */}
                  <div className="flex items-center gap-1.5 flex-none">
                    <SpecHealthChip health={d.acHealth} />
                    {/* spec-409: the seal is always the card's bottom-right corner
                        element (rightmost in this footer group, after the health
                        chip). Grounder name is dropped from the card — it lives in
                        the seal's hover tooltip + the spec page. */}
                    <CodeGroundedBadge
                      groundedInCode={d.groundedInCode ?? false}
                      groundedStale={d.groundedStale ?? false}
                      groundedBy={d.groundedByName ?? null}
                      groundedAt={d.groundedAt ? new Date(d.groundedAt).toLocaleDateString() : null}
                      compact
                    />
                  </div>
                </div>
                {/* spec-136 t-5 (ac-4): the Spec's tags render as read-only chips
                    on the card, straight from the list payload (`d.tags`, which
                    the board requests via `include: ['tags']`). */}
                {d.tags && d.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1" data-testid="spec-card-tags">
                    {d.tags.map((tag) => (
                      <TagChip key={tag.id} tag={tag} />
                    ))}
                  </div>
                )}
                <SpecHealthStrip health={d.acHealth} />
              </Link>
              {canWrite && (
                <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <SpecMenu
                    items={buildMenuItems(d)}
                    size="sm"
                    ariaLabel={`Actions for ${d.title}`}
                  />
                </div>
              )}
            </div>
          );
        })}
        {docs.length === 0 && !onAddSpec && (
          <div className="text-xs text-muted text-center py-6">Drop here</div>
        )}
      </div>
    </div>
  );
}
