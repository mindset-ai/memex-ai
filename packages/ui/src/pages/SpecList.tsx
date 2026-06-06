import { useEffect, useState, useCallback, useMemo, type DragEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchDocs, updateDocStatus, archiveDoc, pauseDoc, unpauseDoc, resetHandholdDemo } from '../api/client';
import { type DocSummary, type DocSummaryAssignee } from '../api/types';
import { statusTextClass } from '../utils/statusStyles';
import { phaseDisplayName } from '../utils/phaseDisplay';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { formatDate, docSeq } from '../utils/format';
import { Spinner } from '../components/Spinner';
import { Badge, Button } from '../components/ui';
import { NewSpecModal } from '../components/NewSpecModal';
import { SpecMenu, type SpecMenuItem } from '../components/SpecMenu';
import { TagChip } from '../components/TagChip';
import { TagFilter } from '../components/TagFilter';
import { ShareModal } from '../components/ShareModal';
import { RenameSpecDialog } from '../components/RenameSpecDialog';
import { MoveSpecDialog } from '../components/MoveSpecDialog';
import { tenantPath, getCurrentTenant } from '../utils/tenantUrl';
import { useAuth } from '../components/AuthContext';
import { useHandholdReveal, nextRevealPhase, type RevealPhase } from '../hooks/useHandholdReveal';
import { useIsFeatureHidden } from '../hooks/useIsFeatureHidden';
import { useMemexAccess } from '../hooks/useMemexAccess';
import { CreateOrgBanner } from '../components/CreateOrgBanner';
import { PageHeader } from '../components/PageHeader';
import { SearchTrigger } from '../components/SearchTrigger';
import {
  borderClassForHealth,
  SpecHealthChip,
  SpecHealthStrip,
} from '../components/SpecHealthIndicator';

// doc-12 t-13: persist the "Show paused" toggle so navigation doesn't reset it.
// Default is false — the kanban hides paused (and always-archived) Specs out
// of the box; users opt into the cluttered view per session.
const SHOW_PAUSED_KEY = 'memex.spec-list.show-paused';

// Per dec-3 / dec-4 of doc-10 the Spec lifecycle is `draft → specify → build →
// verify → done`. Kanban renders the four active columns; `done` lives in a
// collapsible rail on the right (dec-5). `approved` is execution-plan-only
// (t-20 W-B) and never appears on a spec card.
type SpecKanbanStatus = 'draft' | 'specify' | 'build' | 'verify' | 'done';
type ActiveStatus = Exclude<SpecKanbanStatus, 'done'>;

// spec-181: column labels come from the shared phase display-name layer (now a
// plain capitaliser); the `specify` column reads "Specify" straight from the
// enum value, and the ids stay the enum values.
const ACTIVE_COLUMNS: { id: ActiveStatus; label: string }[] = [
  { id: 'draft', label: phaseDisplayName('draft') },
  { id: 'specify', label: phaseDisplayName('specify') },
  { id: 'build', label: phaseDisplayName('build') },
  { id: 'verify', label: phaseDisplayName('verify') },
];

// spec-118: a person's display label + initials for the assignee avatar.
function personLabel(a: { name: string | null; email: string | null }): string {
  return a.name?.trim() || a.email?.trim() || 'Unknown';
}
function initials(label: string): string {
  const parts = label.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// spec-118 ac-18: the assignee(s) shown on a board card — the live responsibility
// pointer, rendered MORE prominently than the creator. A stacked avatar cluster
// (overflow "+N"); an explicit muted "Unassigned" state when there are none.
function AssigneeAvatars({ assignees }: { assignees?: DocSummaryAssignee[] }) {
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
        <span className="text-xs text-secondary truncate max-w-[8rem]">{personLabel(shown[0]!)}</span>
      )}
    </div>
  );
}

interface KanbanColumnProps {
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

function KanbanColumn(props: KanbanColumnProps) {
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
          // doc-12 t-13: paused Specs render with a subtle dimmed treatment
          // and a "Paused" pill so they're visually distinct from active work
          // when the user opts into the wider view via the header toggle.
          const isPaused = !!d.pausedAt;
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
                onDragStart={canWrite ? (e) => onDragStart(e, d.id) : undefined}
                onDragEnd={canWrite ? onDragEnd : undefined}
                className={`block border rounded-md p-3 pr-9 transition-all bg-panel border-edge-subtle hover:border-edge hover:bg-card-hover ${
                  draggingId === d.id ? 'opacity-40' : ''
                } ${isPaused ? 'opacity-60' : ''} ${healthBorder}`}
              >
                <div className="flex items-start gap-2 mb-2">
                  <h3 className="flex-1 text-sm font-medium text-heading leading-snug">
                    {docSeq(d.handle) && (
                      <span className="text-muted font-normal mr-1">{docSeq(d.handle)}.</span>
                    )}
                    {d.title}
                  </h3>
                  {/* spec-178 ac-3/ac-12: the DEMO badge marks each frozen
                      Handhold demo spec on the board. Real specs carry no
                      `isDemo`, so they never render it (ac-11/ac-12). Mirrors the
                      Paused badge's chrome; the two can co-exist on one card. */}
                  {d.isDemo && (
                    <Badge status="demo" label="DEMO" className="flex-none" />
                  )}
                  {isPaused && (
                    <Badge
                      status="paused"
                      label="Paused"
                      className="flex-none"
                      // data-testid via wrapper span — Badge renders a single
                      // <span>, so test selectors latch onto the label text.
                    />
                  )}
                </div>
                {d.isDemo && (
                  // Hidden DOM hook for the test — mirrors the paused pill: the
                  // visible Badge above is the user-facing surface, this lets a
                  // test assert the DEMO pill without coupling to Badge classes.
                  <span data-testid="spec-demo-pill" className="sr-only">
                    DEMO
                  </span>
                )}
                {isPaused && (
                  // Hidden DOM hook for the test — the visible Badge above is
                  // the user-facing surface; this lets us assert the pill
                  // without coupling tests to the Badge's class names.
                  <span data-testid="spec-paused-pill" className="sr-only">
                    Paused
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
                  <SpecHealthChip health={d.acHealth} />
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

/**
 * Spec board (per dec-25). Shows only `docType='spec'` documents in a
 * 4-column kanban (draft → review → implementation → done) with drag-and-drop.
 *
 * Spec cards expose the parent-spec lineage from `parentDocId` (set by
 * `promoteToSpec`, dec-11). When a spec was promoted from another doc
 * the card surfaces "Promoted from <parent-handle>" below the title so users
 * see the lineage without opening the doc.
 */
export function SpecList() {
  const { session, user } = useAuth();
  // spec-118 ac-19: the assignee filter lives in the URL (?assignee=all|me|<userId>)
  // so a filtered board is shareable, matching the board's existing URL conventions.
  const [searchParams, setSearchParams] = useSearchParams();
  const assigneeFilter = searchParams.get('assignee') ?? 'all';
  const setAssigneeFilter = useCallback(
    (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === 'all') next.delete('assignee');
          else next.set('assignee', value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  // spec-136 t-7 (ac-3): the board tag filter lives in the URL (?tags=scope::value
  // &tags=bug) so a filtered board is shareable, matching the assignee filter's
  // URL convention. Multi-valued: each selected tag is its own repeated param,
  // exactly the shape fetchDocs({ tags }) sends to the server.
  const tagFilter = useMemo(() => searchParams.getAll('tags'), [searchParams]);
  const setTagFilter = useCallback(
    (next: string[]) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.delete('tags');
          for (const t of next) params.append('tags', t);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  // spec-111 t-8: gate every create/edit affordance on write access to the
  // current Memex. A non-member on a public Memex reads the full board but sees
  // no "+ New Spec", no add-card, no per-card menu, and no drag-to-restatus.
  const { canWrite } = useMemexAccess();
  // spec-147 t-1 (dec-1 / Option A): when 'spec-pause' is in the session's
  // hiddenFeatures the pause affordances disappear — the "Show paused" header
  // toggle and the per-card Pause/Unpause menu item are not rendered, and the
  // board stops filtering out already-paused Specs (so hiding the feature never
  // silently drops in-flight work). Fail-open: no session / missing field →
  // not hidden, i.e. today's behavior.
  const pauseHidden = useIsFeatureHidden('spec-pause');
  // doc-19 dec-8: surface the Create-an-Org banner only when the user is
  // looking at their personal Memex's Specs page. The CreateOrgBanner
  // component handles the dismissal + has-org-membership suppression itself.
  const currentMembership = session?.memberships.find(
    (m) => m.memexId === session?.currentMemexId,
  );
  const showPersonalBanner = currentMembership?.kind === 'personal';
  // spec-178 t-10 (dec-10): the progressive-reveal pointer. The five demo specs
  // are all seeded (one per phase) but only ONE is shown on the board at a time
  // — the one whose status === revealedPhase. Advancing the pointer walks the
  // demo across the board (draft → specify → build → verify → done). Purely a
  // client-side affordance, keyed by the current tenant so each personal Memex
  // tracks its own walkthrough. `getCurrentTenant()` is null on caller-scoped
  // routes; the hook is null-safe and just collapses to a shared key there.
  const revealTenant = getCurrentTenant();
  const { revealedPhase, advance: advanceReveal, reset: resetReveal } = useHandholdReveal(
    revealTenant?.namespace ?? null,
    revealTenant?.memex ?? null,
  );
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<SpecKanbanStatus | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [shareDocId, setShareDocId] = useState<string | null>(null);
  const [renameDoc, setRenameDoc] = useState<DocSummary | null>(null);
  const [moveDoc_, setMoveDoc] = useState<DocSummary | null>(null);
  // Default-collapsed Done column (dec-5). Drop targets stay live in the rail.
  // Resets on every mount — leaving Done open across navigations made the board
  // feel cluttered, so we trade persistence for a clean default each visit.
  const [doneExpanded, setDoneExpanded] = useState(false);
  // doc-12 t-13: "Show paused" toggle. Reads localStorage on first render so
  // the user's preference survives navigation. Archived Specs are always
  // hidden from this board (no UI for them in this iteration — deferred).
  const [showPaused, setShowPaused] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(SHOW_PAUSED_KEY) === 'true';
    } catch {
      // localStorage can throw under privacy modes / disabled storage — fall
      // back to the default-off behavior rather than crashing the page.
      return false;
    }
  });

  // Persist on every flip. Writing 'true' / 'false' (not removing on false)
  // makes the read deterministic — distinguishes "user explicitly opted out"
  // from "first visit", though the read above treats both the same today.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SHOW_PAUSED_KEY, showPaused ? 'true' : 'false');
    } catch {
      // Same fallback as the reader — silent on storage failures.
    }
  }, [showPaused]);

  // spec-178 t-10 (dec-10): when the demo has been walked all the way to 'done'
  // the revealed card lives in the Done rail — which collapses by default.
  // Auto-expand it whenever a done-phase demo is the revealed card so the
  // walkthrough's final card (and its on-card "Reset demo" control) is visible,
  // including on a fresh page load with the pointer already at 'done'.
  const hasRevealedDoneDemo = docs.some((d) => d.isDemo && d.status === 'done');
  useEffect(() => {
    if (revealedPhase === 'done' && hasRevealedDoneDemo) setDoneExpanded(true);
  }, [revealedPhase, hasRevealedDoneDemo]);

  const loadDocs = useCallback(() => {
    // b-66 t-3: ask the server for the per-Spec AC-health roll-up. The
    // `useDocChangeStream` effect below already refetches `loadDocs` on every
    // doc event, so health refreshes ride that channel for free. Note: health
    // changes triggered by `test_events` inserts alone do NOT push a refresh
    // through this channel — the manager sees the new state on the next doc
    // event or page reload. Acceptable for v1; a dedicated nudge is out of
    // scope.
    // spec-136 t-4/t-7: always request `include: ['tags']` so cards can render
    // chips (develop attaches tags only under `include=tags` — differs from the
    // pre-develop unconditional attach). The tag facet is additive to the
    // docType filter; the server ANDs across scopes / ORs within a scope. Omit
    // the `tags` opt when no filter is selected so an empty facet never 400s.
    fetchDocs('spec', {
      include: ['acHealth', 'assignees', 'tags'],
      ...(tagFilter.length > 0 ? { tags: tagFilter } : {}),
    })
      .then((data) => {
        const sorted = [...data].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setDocs(sorted);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tagFilter]);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  useDocChangeStream(null, loadDocs);

  // Build a quick lookup so we can render parent specs on cards without
  // a second round trip. Specs-promoted-from-specs hit this path
  // directly; for cross-type lineage (a spec promoted from a non-spec
  // doc) the server now ships a `parent` projection on every promoted summary
  // (t-20 W-F), so we fall back to that when the parent isn't in this list.
  const docsById = useMemo(() => {
    const map = new Map<string, DocSummary>();
    for (const d of docs) map.set(d.id, d);
    return map;
  }, [docs]);

  // spec-118 ac-19: the distinct people currently assigned across the board, for
  // the "assigned to <person>" filter options. Derived from the loaded payload —
  // no extra fetch. "Assigned to me" matches by email (the session user carries no
  // id), and "all" is the default.
  const assigneePeople = useMemo(() => {
    const byId = new Map<string, string>();
    for (const d of docs) {
      for (const a of d.assignees ?? []) {
        if (!byId.has(a.userId)) byId.set(a.userId, a.name?.trim() || a.email?.trim() || 'Unknown');
      }
    }
    return Array.from(byId, ([userId, label]) => ({ userId, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [docs]);

  const matchesAssigneeFilter = useCallback(
    (d: DocSummary): boolean => {
      if (assigneeFilter === 'all') return true;
      const assignees = d.assignees ?? [];
      if (assigneeFilter === 'me') {
        const myEmail = user?.email;
        return !!myEmail && assignees.some((a) => a.email && a.email === myEmail);
      }
      return assignees.some((a) => a.userId === assigneeFilter);
    },
    [assigneeFilter, user?.email],
  );

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
      console.error('Failed to update status', err);
      setDocs(previous);
    }
  };

  const handleArchive = useCallback(async (doc: DocSummary) => {
    if (!window.confirm(`Archive "${doc.title}"? It'll be hidden from the board.`)) return;
    const previous = docs;
    // Optimistic removal — SSE will confirm for other clients.
    setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    try {
      await archiveDoc(doc.id);
    } catch (err) {
      console.error('Failed to archive', err);
      setDocs(previous);
      window.alert(err instanceof Error ? err.message : 'Failed to archive spec');
    }
  }, [docs]);

  const handleTogglePause = useCallback(async (doc: DocSummary) => {
    const wasPaused = !!doc.pausedAt;
    const previous = docs;
    // Optimistic — SSE confirms for other clients.
    setDocs((prev) =>
      prev.map((d) =>
        d.id === doc.id ? { ...d, pausedAt: wasPaused ? null : new Date().toISOString() } : d,
      ),
    );
    try {
      await (wasPaused ? unpauseDoc(doc.id) : pauseDoc(doc.id));
    } catch (err) {
      console.error('Failed to toggle pause', err);
      setDocs(previous);
      window.alert(err instanceof Error ? err.message : 'Failed to update pause state');
    }
  }, [docs]);

  // spec-178 ac-18/ac-19: re-seed the personal Memex's Handhold demo. The button
  // that calls this is shown ONLY when at least one demo spec is on the board (see
  // hasDemoSpecs below); a window.confirm step (ac-19) gates the destructive
  // re-seed before the endpoint is hit. The namespace/memex come from the current
  // tenant context (the path-based router puts them in the first two URL segments).
  // After the reset the board refetches so the re-seeded specs replace the old set.
  const [resetting, setResetting] = useState(false);
  const handleResetDemo = useCallback(async () => {
    const tenant = getCurrentTenant();
    if (!tenant) return;
    if (
      !window.confirm(
        'Reset the demo specs? This deletes the current demo specs and re-seeds a fresh set. Your real specs are untouched.',
      )
    ) {
      return;
    }
    setResetting(true);
    try {
      await resetHandholdDemo(tenant.namespace, tenant.memex);
      // spec-178 ac-34 (dec-10): a board Reset restores the draft-only view —
      // re-seed the demo specs AND snap the reveal pointer back to 'draft' so
      // only the first demo spec shows again.
      resetReveal();
      loadDocs();
    } catch (err) {
      console.error('Failed to reset demo', err);
      window.alert(err instanceof Error ? err.message : 'Failed to reset demo');
    } finally {
      setResetting(false);
    }
  }, [loadDocs, resetReveal]);

  const buildMenuItems = useCallback(
    (doc: DocSummary): SpecMenuItem[] => {
      const items: SpecMenuItem[] = [
        { label: 'Rename', onClick: () => setRenameDoc(doc) },
        { label: 'Share', onClick: () => setShareDocId(doc.id) },
      ];
      // spec-147 t-1: omit Pause/Unpause when the pause feature is hidden. The
      // Pause item carries the divider that separates the rename/share group
      // from the move/archive group — when it's gone, move that divider onto
      // "Move to another memex" so the grouping stays correct and we never
      // leave an orphaned (or leading) separator.
      if (!pauseHidden) {
        items.push({
          label: doc.pausedAt ? 'Unpause' : 'Pause',
          onClick: () => handleTogglePause(doc),
          separatorBefore: true,
        });
      }
      items.push(
        { label: 'Move to another memex', onClick: () => setMoveDoc(doc), separatorBefore: pauseHidden },
        { label: 'Archive', onClick: () => handleArchive(doc), danger: true, separatorBefore: true },
      );
      return items;
    },
    [handleArchive, handleTogglePause, pauseHidden],
  );

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-8">
        <div className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text">
          Failed to load specs: {error}
        </div>
      </div>
    );
  }

  const docsByColumn: Record<SpecKanbanStatus, DocSummary[]> = {
    draft: [],
    specify: [],
    build: [],
    verify: [],
    done: [],
  };
  // spec-147 t-1 (Option A): when the pause feature is hidden the "Show paused"
  // toggle is gone, so a paused Spec could otherwise vanish from the board with
  // no way to bring it back. Force-include paused Specs in that case — they keep
  // their "Paused" badge + dimming, they just stop being filterable.
  const effectiveShowPaused = pauseHidden || showPaused;
  for (const d of docs) {
    // doc-12 t-13: archived Specs are always hidden from the kanban (the
    // server already filters them out by default, but defending here keeps
    // the contract local). Paused Specs are hidden unless the user has
    // flipped the "Show paused" toggle (or the pause feature is hidden — see
    // effectiveShowPaused above).
    if (d.archivedAt) continue;
    if (d.pausedAt && !effectiveShowPaused) continue;
    // spec-178 ac-33/ac-34 (dec-10): progressive reveal. fetchDocs returns all
    // five demo specs (one per phase), but the board shows only the one whose
    // status matches the reveal pointer — hide the other four client-side. Real
    // (non-demo) specs are never touched by this filter. Demo specs carry the
    // canonical phase values (draft/specify/build/verify/done), so we compare the
    // raw status against the pointer before the legacy review/implementation
    // remap below (which never applies to demo rows).
    if (d.isDemo && d.status !== revealedPhase) continue;
    // spec-118 ac-19: assignee filter (assigned to me / specific person / all).
    if (!matchesAssigneeFilter(d)) continue;
    // Specs should never carry `approved` (execution-plan terminal state, t-20 W-B);
    // the legacy `review`/`implementation` are migrated to `specify`/`build` by the doc-10
    // backfill. Defensive remap covers any racing rows that slipped past the migration.
    if (d.status === 'approved') continue;
    const remapped: SpecKanbanStatus =
      d.status === 'review'
        ? 'specify'
        : d.status === 'implementation'
        ? 'build'
        : (d.status as SpecKanbanStatus);
    if (!(remapped in docsByColumn)) continue;
    docsByColumn[remapped].push(d);
  }

  // spec-178 t-10 (dec-10): the phase the revealed demo spec advances INTO. Null
  // at the terminal 'done' phase — its advance control becomes "Reset demo".
  const revealNextPhase = nextRevealPhase(revealedPhase);
  // Advancing the reveal one phase along. When the next phase is 'done' the demo
  // card lands in the Done rail (collapsed by default) — auto-expand it so the
  // walkthrough's final card (and its "Reset demo" control) is actually visible.
  const onAdvanceDemo = () => {
    if (revealNextPhase === 'done') setDoneExpanded(true);
    advanceReveal();
  };
  // The done-phase terminal control re-uses the SAME action as the board's
  // header Reset button (re-seed + pointer reset). Only meaningful when at
  // least one demo spec is on the board; the demo card render gates on isDemo.
  const onResetDemo = handleResetDemo;

  return (
    <div className="h-full flex flex-col px-6 py-6">
      {showPersonalBanner && <CreateOrgBanner />}
      <PageHeader
        title="Specs"
        actions={
          <>
            {/* spec-118 ac-19: assignee filter. Options: All, Assigned to me, and
                each person currently assigned across the board. URL-reflected. */}
            <label className="flex items-center gap-1.5 text-xs text-secondary select-none">
              <span className="text-muted">Assignee</span>
              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                aria-label="Filter by assignee"
                className="bg-surface border border-edge-subtle rounded px-1.5 py-1 text-xs text-primary cursor-pointer"
              >
                <option value="all">All</option>
                <option value="me">Assigned to me</option>
                {assigneePeople.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {/* doc-12 t-13: "Show paused" header toggle. Native checkbox styled
                to match the lightweight visual language of the kanban header —
                no dedicated Toggle primitive in the UI kit yet, and a labelled
                checkbox plays nicely with the existing test surface.
                spec-147 t-1: suppressed entirely when the pause feature is
                hidden (the board force-includes paused Specs in that case). */}
            {!pauseHidden && (
              <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showPaused}
                  onChange={(e) => setShowPaused(e.target.checked)}
                  className="cursor-pointer"
                />
                Show paused
              </label>
            )}
            {/* spec-178 ac-18: the Reset-demo button appears on the board header
                ONLY when at least one demo spec is present, and is absent
                otherwise. ac-19: clicking it confirms before the re-seed runs.
                Gated on write access alongside the other mutating board controls. */}
            {canWrite && docs.some((d) => d.isDemo) && (
              <Button
                variant="secondary"
                onClick={handleResetDemo}
                disabled={resetting}
                data-testid="reset-demo-button"
              >
                {resetting ? 'Resetting…' : 'Reset demo'}
              </Button>
            )}
            {canWrite && <Button onClick={() => setModalOpen(true)}>+ New Spec</Button>}
            {/* spec-192 t-4 (dec-1): the Specs board is the ONLY list page that
                carries a search trigger, and it's wired HERE in SpecList — not in
                the shared PageHeader — so no other list page (Issues / Standards /
                Insights / Pulse) gets one. Shown to everyone (search is a read
                action), so it is NOT gated on canWrite. */}
            <SearchTrigger variant="spec-board" />
          </>
        }
      />

      {/* spec-136 t-7 (ac-3): board-level tag filter. Narrows the kanban to
          Specs carrying the selected tags; clearable. The selection lives in the
          URL (?tags=) so a filtered board is shareable. */}
      <div className="flex-none mb-4">
        <TagFilter selected={tagFilter} onChange={setTagFilter} />
      </div>

      {/* Board row. overflow-x-auto + a per-column min width: flex children
          default to min-width:auto, so without these the columns can't shrink
          below their card content and an expanded Done column pushes the row
          past the viewport with no way to scroll right (user-reported). On wide
          screens flex-1 still distributes evenly; on narrow ones the board
          scrolls horizontally instead of clipping. */}
      <div className="flex-1 min-h-0 flex gap-4 overflow-x-auto" data-testid="kanban-board">
        {ACTIVE_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.id}
            id={col.id}
            label={col.label}
            docs={docsByColumn[col.id]}
            docsById={docsById}
            isOver={dragOverColumn === col.id}
            draggingId={draggingId}
            buildMenuItems={buildMenuItems}
            canWrite={canWrite}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDragLeave={() => setDragOverColumn((c) => (c === col.id ? null : c))}
            onDrop={handleDrop}
            className="flex-1 min-w-[14rem]"
            onAddSpec={col.id === 'draft' ? () => setModalOpen(true) : undefined}
            revealNextPhase={revealNextPhase}
            onAdvanceDemo={onAdvanceDemo}
            onResetDemo={onResetDemo}
          />
        ))}
        {/* Done rail (dec-5): collapsed by default, click to expand. While a
            drag is hovering the rail, auto-expand so the user can see what
            they're dropping into; reverts to collapsed when the drag ends or
            leaves (handleDrop / handleDragEnd / dragLeave clear dragOverColumn).
            Drop targets stay live in the collapsed state too. */}
        {(doneExpanded || (draggingId !== null && dragOverColumn === 'done')) ? (
          <div className="flex-1 min-w-[14rem] flex flex-col min-h-0">
            <KanbanColumn
              id="done"
              label="Done"
              docs={docsByColumn.done}
              docsById={docsById}
              isOver={dragOverColumn === 'done'}
              draggingId={draggingId}
              buildMenuItems={buildMenuItems}
              canWrite={canWrite}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onDragLeave={() => setDragOverColumn((c) => (c === 'done' ? null : c))}
              onDrop={handleDrop}
              className="flex-1"
              revealNextPhase={revealNextPhase}
              onAdvanceDemo={onAdvanceDemo}
              onResetDemo={onResetDemo}
              headerExtra={
                <button
                  type="button"
                  onClick={() => setDoneExpanded(false)}
                  className="text-xs text-muted hover:text-secondary px-1"
                  aria-label="Collapse Done column"
                >
                  ×
                </button>
              }
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDoneExpanded(true)}
            onDragOver={(e) => handleDragOver(e, 'done')}
            onDragLeave={() => setDragOverColumn((c) => (c === 'done' ? null : c))}
            onDrop={(e) => handleDrop(e, 'done')}
            className={`w-12 flex-none flex flex-col items-center justify-start gap-3 py-3 rounded-lg border transition-colors ${
              dragOverColumn === 'done'
                ? 'border-edge-strong bg-overlay'
                : 'border-edge-subtle bg-surface/40 hover:bg-surface/60'
            }`}
            aria-label={`Expand Done column (${docsByColumn.done.length} spec${docsByColumn.done.length === 1 ? '' : 's'})`}
          >
            <span
              className={`text-xs font-medium uppercase tracking-wider ${statusTextClass('done')} [writing-mode:vertical-rl] rotate-180`}
            >
              Done
            </span>
            <span className="text-xs text-muted tabular-nums">{docsByColumn.done.length}</span>
          </button>
        )}
      </div>

      <NewSpecModal open={modalOpen} onClose={() => setModalOpen(false)} />
      {shareDocId && <ShareModal docId={shareDocId} onClose={() => setShareDocId(null)} />}
      {renameDoc && (
        <RenameSpecDialog
          docId={renameDoc.id}
          currentTitle={renameDoc.title}
          onClose={() => setRenameDoc(null)}
          onRenamed={loadDocs}
        />
      )}
      {moveDoc_ && (
        <MoveSpecDialog
          docId={moveDoc_.id}
          title={moveDoc_.title}
          onClose={() => setMoveDoc(null)}
          onMoved={() => {
            setDocs((prev) => prev.filter((d) => d.id !== moveDoc_.id));
            setMoveDoc(null);
          }}
        />
      )}
    </div>
  );
}
