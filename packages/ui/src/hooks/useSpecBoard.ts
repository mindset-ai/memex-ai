import { useState, type DragEvent, type Dispatch, type SetStateAction } from 'react';
import { DONE_GATE_BLOCKED, updateDocStatus } from '../api/client';
import { ApiError } from '../api/errors';
import { type DocSummary } from '../api/types';
import { useTelemetry } from './useTelemetry';
import { type SpecKanbanStatus } from '../components/spec-board/types';

interface UseSpecBoardArgs {
  // The current board docs + their setter — the drop handler reads the dragged
  // doc's current status and applies the optimistic status update (with rollback).
  docs: DocSummary[];
  setDocs: Dispatch<SetStateAction<DocSummary[]>>;
  // spec-111 t-8: a non-member can't restatus a spec; the drop handler bails.
  canWrite: boolean;
  // A card landing in Done sticks the Done column open so the user sees what
  // they just dropped.
  setDoneExpanded: Dispatch<SetStateAction<boolean>>;
}

/**
 * spec-566 dec-10 (ac-29) — a drop the done-gate refused.
 *
 * Non-null means: the card has been rolled back AND the user is owed the
 * override affordance. Rolling back alone is the spec-391 behaviour that got a
 * block at this seam reverted — the card just snapped home and said nothing.
 */
export interface GateBlockedDrop {
  docId: string;
  /** The server's refusal, which names the criterion and the calls that clear it. */
  message: string;
  /** The column the drop was aiming at, so a successful override can complete it. */
  target: SpecKanbanStatus;
}

export interface SpecBoardDnd {
  draggingId: string | null;
  dragOverColumn: SpecKanbanStatus | null;
  setDragOverColumn: Dispatch<SetStateAction<SpecKanbanStatus | null>>;
  handleDragStart: (e: DragEvent<HTMLElement>, docId: string) => void;
  handleDragEnd: () => void;
  handleDragOver: (e: DragEvent<HTMLElement>, column: SpecKanbanStatus) => void;
  handleDrop: (e: DragEvent<HTMLElement>, column: SpecKanbanStatus) => Promise<void>;
  /** spec-566 ac-29: set when a drop hit the done-gate. The page renders the
   *  override affordance from it; null the rest of the time. */
  gateBlocked: GateBlockedDrop | null;
  /** Dismiss the override affordance without overriding. */
  clearGateBlocked: () => void;
  /** Complete the refused drop after an override has been recorded. */
  completeAfterOverride: () => Promise<void>;
}

/**
 * The Specs board drag-and-drop state machine, lifted out of SpecList (spec-365
 * sol-6). Owns the drag/hover state and the start/end/over/drop handlers,
 * including the optimistic `updateDocStatus` with rollback, the
 * `board.phase_drag` telemetry, the read-only guard, and the Done-column
 * auto-expand-on-drop. Behaviour is identical to the previous inline handlers.
 */
export function useSpecBoard({
  docs,
  setDocs,
  canWrite,
  setDoneExpanded,
}: UseSpecBoardArgs): SpecBoardDnd {
  const { track } = useTelemetry(true);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<SpecKanbanStatus | null>(null);
  const [gateBlocked, setGateBlocked] = useState<GateBlockedDrop | null>(null);

  const handleDragStart = (e: DragEvent<HTMLElement>, docId: string) => {
    setDraggingId(docId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', docId);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverColumn(null);
  };

  const handleDragOver = (e: DragEvent<HTMLElement>, column: SpecKanbanStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverColumn !== column) setDragOverColumn(column);
  };

  const handleDrop = async (e: DragEvent<HTMLElement>, column: SpecKanbanStatus) => {
    e.preventDefault();
    // Read-only guard (spec-111 t-8): a non-member can't restatus a spec even
    // if a drag somehow fires. Server also rejects via canWriteMemex (t-5).
    if (!canWrite) return;
    const docId = e.dataTransfer.getData('text/plain') || draggingId;
    setDraggingId(null);
    setDragOverColumn(null);
    if (!docId) return;

    const current = docs.find((d) => d.id === docId);
    if (!current || current.status === column) return;

    // The drag interaction (intent). The OUTCOME is document.status_changed
    // (back-end); this captures whether drag-to-move is used vs the detail view.
    track('board.phase_drag', { from: current.status, to: column });

    // Promote the drag-time auto-expand to a sticky open state once a card
    // actually lands in Done, so the user can see what they just dropped.
    if (column === 'done') setDoneExpanded(true);

    const previous = docs;
    setDocs((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, status: column } : d))
    );
    try {
      await updateDocStatus(docId, column);
    } catch (err) {
      // spec-566 dec-10 (ac-29) — the branch that separates this from
      // spec-391's reverted block. A gate refusal is not a fault: roll the card
      // back, AND hand the user the override. Rolling back in silence is what
      // "moving a card on the kanban must never error out" was really objecting
      // to, and it is what this branch exists to not do.
      if (err instanceof ApiError && err.code === DONE_GATE_BLOCKED) {
        setDocs(previous);
        setGateBlocked({ docId, message: err.message, target: column });
        return;
      }
      console.error('Failed to update status', err);
      setDocs(previous);
    }
  };

  /**
   * Re-run the refused move once an override has been recorded. Kept here rather
   * than in the dialog so the optimistic update and its rollback stay in one
   * place — two owners of the same card state is how a board starts lying.
   */
  const completeAfterOverride = async () => {
    const pending = gateBlocked;
    if (!pending) return;
    setGateBlocked(null);
    const previous = docs;
    setDocs((prev) =>
      prev.map((d) => (d.id === pending.docId ? { ...d, status: pending.target } : d)),
    );
    try {
      await updateDocStatus(pending.docId, pending.target);
    } catch (err) {
      console.error('Failed to update status after override', err);
      setDocs(previous);
    }
  };

  return {
    draggingId,
    dragOverColumn,
    setDragOverColumn,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDrop,
    gateBlocked,
    clearGateBlocked: () => setGateBlocked(null),
    completeAfterOverride,
  };
}
