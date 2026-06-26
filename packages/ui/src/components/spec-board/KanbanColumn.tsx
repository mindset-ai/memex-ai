import { type DragEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { type DocSummary } from '../../api/types';
import { statusTextClass } from '../../utils/statusStyles';
import { phaseDisplayName } from '../../utils/phaseDisplay';
import { formatDate, docSeq } from '../../utils/format';
import { Badge } from '../ui';
import { CodeGroundedBadge } from '../CodeGroundedBadge';
import { SpecMenu, type SpecMenuItem } from '../SpecMenu';
import { TagChip } from '../TagChip';
import { tenantPath } from '../../utils/tenantUrl';
import { useTelemetry } from '../../hooks/useTelemetry';
import { type RevealPhase } from '../../hooks/useHandholdReveal';
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
  // spec-178 t-10 (dec-10): progressive-reveal advance control. Rendered ONLY on
  // is_demo cards. `revealNextPhase` is the phase that follows the revealed one
  // (null at 'done' — the terminal phase, where the control becomes Reset).
  // `onAdvanceDemo` bumps the reveal pointer; `onResetDemo` is the done-phase
  // terminal action (re-seed + pointer reset). Absent on non-demo boards.
  revealNextPhase?: RevealPhase | null;
  onAdvanceDemo?: () => void;
  onResetDemo?: () => void;
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
    revealNextPhase,
    onAdvanceDemo,
    onResetDemo,
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
            <div key={d.id} className="relative group">
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
                  {/* spec-178 ac-3/ac-12: the DEMO badge marks each frozen
                      Handhold demo spec on the board. Real specs carry no
                      `isDemo`, so they never render it (ac-11/ac-12). */}
                  {d.isDemo && (
                    <Badge status="demo" label="DEMO" className="flex-none" />
                  )}
                </div>
                {d.isDemo && (
                  // Hidden DOM hook for the test — the visible Badge above is
                  // the user-facing surface, this lets a test assert the DEMO
                  // pill without coupling to Badge classes.
                  <span data-testid="spec-demo-pill" className="sr-only">
                    DEMO
                  </span>
                )}
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
              {/* spec-178 ac-33/ac-34 (dec-10): the progressive-reveal advance
                  control. Renders ONLY on is_demo cards (never on real specs),
                  and only when the demo-management callbacks are wired (i.e. the
                  board owns a reveal pointer). Clicking it walks the demo one
                  phase along — the current card disappears and the next phase's
                  demo card appears, giving the impression of one spec moving
                  across the board. At the terminal 'done' phase there is no
                  next: the control becomes "Reset demo", wired to the same
                  re-seed + pointer-reset as the board header's Reset button. */}
              {d.isDemo && onAdvanceDemo && onResetDemo && (
                revealNextPhase ? (
                  <button
                    type="button"
                    data-testid="demo-advance-control"
                    onClick={onAdvanceDemo}
                    className="mt-2 w-full text-xs font-medium text-accent hover:text-accent-hover inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border border-accent/40 bg-accent/10 hover:bg-accent/20 transition-colors"
                  >
                    See it in {phaseDisplayName(revealNextPhase)} →
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="demo-reset-control"
                    onClick={onResetDemo}
                    className="mt-2 w-full text-xs font-medium text-secondary hover:text-primary inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border border-edge hover:bg-overlay transition-colors"
                  >
                    Reset demo
                  </button>
                )
              )}
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
