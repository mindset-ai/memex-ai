import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useSearchParams, useLocation } from 'react-router-dom';
import { fetchDocs } from '../api/client';
import { type DocSummary } from '../api/types';
import { statusTextClass } from '../utils/statusStyles';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { Spinner } from '../components/Spinner';
import { Button } from '../components/ui';
import { NewSpecModal } from '../components/NewSpecModal';
import { type SpecMenuItem } from '../components/SpecMenu';
import { TagFilter } from '../components/TagFilter';
import { ShareModal } from '../components/ShareModal';
import { RenameSpecDialog } from '../components/RenameSpecDialog';
import { ArchiveSpecDialog } from '../components/ArchiveSpecDialog';
import { MoveSpecDialog } from '../components/MoveSpecDialog';
import { parseTenantFromPathname, tenantPath } from '../utils/tenantUrl';
import { useAuth } from '../components/AuthContext';
import { useMemexAccess } from '../hooks/useMemexAccess';
import { CreateOrgBanner } from '../components/CreateOrgBanner';
import { PageHeader } from '../components/PageHeader';
import { SearchTrigger } from '../components/SearchTrigger';
import { phaseDisplayName } from '../utils/phaseDisplay';
import { KanbanColumn } from '../components/spec-board/KanbanColumn';
import { type SpecKanbanStatus, type ActiveStatus } from '../components/spec-board/types';
import { useSpecBoard } from '../hooks/useSpecBoard';

// spec-181: column labels come from the shared phase display-name layer (now a
// plain capitaliser); the `specify` column reads "Specify" straight from the
// enum value, and the ids stay the enum values.
const ACTIVE_COLUMNS: { id: ActiveStatus; label: string }[] = [
  { id: 'draft', label: phaseDisplayName('draft') },
  { id: 'specify', label: phaseDisplayName('specify') },
  { id: 'build', label: phaseDisplayName('build') },
  { id: 'verify', label: phaseDisplayName('verify') },
];

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
  // spec-447: remember the assignee filter per-tenant so it survives the
  // round-trip into a spec and back. The filter lives in the URL (spec-118
  // ac-19), but the "← All specs" header link (AppShell) navigates to a BARE
  // /specs — resolveNavTo drops the query string — so returning that way lost
  // the filter. We mirror the active value into a per-tenant sessionStorage key
  // and restore it on mount when the URL carries no ?assignee. Router-aware
  // tenant (useLocation, not window.location) so the key resolves in tests too.
  const location = useLocation();
  const filterTenant = parseTenantFromPathname(location.pathname);
  const assigneeStorageKey = filterTenant
    ? `specboard:assignee:${filterTenant.namespace}/${filterTenant.memex}`
    : null;
  const setAssigneeFilter = useCallback(
    (value: string) => {
      // Persist the selection (including a deliberate "all", which clears the
      // remembered value so a clear is honoured, never re-applied — ac-3).
      if (assigneeStorageKey) {
        try {
          if (value === 'all') sessionStorage.removeItem(assigneeStorageKey);
          else sessionStorage.setItem(assigneeStorageKey, value);
        } catch {
          // sessionStorage unavailable (private mode / disabled) — persistence
          // is best-effort; the URL still reflects the filter this session.
        }
      }
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
    [setSearchParams, assigneeStorageKey],
  );
  // spec-447: restore the remembered assignee filter when the board is opened
  // with no ?assignee in the URL (the "← All specs" round-trip, the logo link,
  // a fresh visit). The URL is the source of truth: if it already carries
  // ?assignee (a shared link or the browser-back path) we honour it as-is and
  // do NOT touch storage — only a filter the user actively selects
  // (setAssigneeFilter) becomes the remembered default. Mirroring a URL-supplied
  // value here would let someone else's shared ?assignee=<uuid> link silently
  // become your sticky default for the rest of the session (and, if that user
  // has no assignments, strand you on a blank-dropdown empty board). Otherwise
  // we write the remembered value back into the URL so the restored filter stays
  // shareable (spec-118 ac-19). Keyed per-tenant, so a filter set on one Memex's
  // board never leaks onto another (ac-4).
  useEffect(() => {
    if (!assigneeStorageKey) return;
    // URL wins: an explicit ?assignee (shared link / browser-back) is honoured
    // for this view without being promoted to the remembered default.
    if (searchParams.get('assignee')) return;
    let remembered: string | null = null;
    try {
      remembered = sessionStorage.getItem(assigneeStorageKey);
    } catch {
      return;
    }
    if (remembered && remembered !== 'all') {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('assignee', remembered as string);
          return next;
        },
        { replace: true },
      );
    }
    // Runs on mount and when the tenant key changes; intentionally not on every
    // searchParams change so a user's clear is not immediately re-applied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigneeStorageKey]);
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
  // spec-409: the board can be narrowed to only code-grounded Specs. URL-reflected
  // (?grounded=1) so a filtered board is shareable, matching the assignee/tag
  // filter conventions.
  const groundedOnly = searchParams.get('grounded') === '1';
  const setGroundedOnly = useCallback(
    (on: boolean) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (on) next.set('grounded', '1');
          else next.delete('grounded');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  // spec-447: with the assignee filter now persisting across the round-trip, a
  // filtered board must never look unfiltered — the active state has to be
  // visible in the UI, not just in the URL, and clearable in one action. This
  // covers all three URL-reflected board filters (assignee / tags / grounded) so
  // "Clear filters" always returns the board to its full, unfiltered view.
  const hasActiveFilters = assigneeFilter !== 'all' || tagFilter.length > 0 || groundedOnly;
  const clearAllFilters = useCallback(() => {
    // Clearing the assignee also drops its remembered value, so a deliberate
    // clear is honoured and never re-applied on the next mount (ac-3 semantics).
    if (assigneeStorageKey) {
      try {
        sessionStorage.removeItem(assigneeStorageKey);
      } catch {
        // best-effort — see setAssigneeFilter.
      }
    }
    // ONE setSearchParams that drops all three params. Three separate setters
    // would NOT compose: react-router's functional updater reads the same params
    // snapshot within a batch and the last navigate wins, so only one filter
    // would actually clear. Delete them together in a single navigate.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('assignee');
        next.delete('tags');
        next.delete('grounded');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams, assigneeStorageKey]);
  // doc-19 dec-8: surface the Create-an-Org banner only when the user is
  // looking at their personal Memex's Specs page. The CreateOrgBanner
  // component handles the dismissal + has-org-membership suppression itself.
  const currentMembership = session?.memberships.find(
    (m) => m.memexId === session?.currentMemexId,
  );
  const showPersonalBanner = currentMembership?.kind === 'personal';
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // spec-482 (dec-4, ac-24): only the ?new=1 ONBOARDING entry lands the user
  // directly on the created Spec. The board's own "+ New Spec" button keeps
  // spec-230's manual "Open Spec" completion footer — this flag scopes the
  // land-on-create behaviour to onboarding and leaves spec-230's flow untouched.
  const [landOnCreate, setLandOnCreate] = useState(false);
  const [shareDocId, setShareDocId] = useState<string | null>(null);
  const [renameDoc, setRenameDoc] = useState<DocSummary | null>(null);
  // spec-521 t-4 (ac-4): the Spec awaiting an archive confirm, so the dialog can ask
  // for a reason instead of a bare yes/no.
  const [archiveDoc, setArchiveDoc] = useState<DocSummary | null>(null);
  const [moveDoc_, setMoveDoc] = useState<DocSummary | null>(null);

  // spec-303: the Home Canvas "Create your first spec" CTA deep-links here with
  // ?new=1 to open the SAME NewSpecModal the board's "+ New Spec" button uses —
  // no second create path. The param is cleared so a refresh doesn't re-open it.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setModalOpen(true);
      setLandOnCreate(true); // spec-482: onboarding entry lands on the Spec
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Default-collapsed Done column (dec-5). Drop targets stay live in the rail.
  // Resets on every mount — leaving Done open across navigations made the board
  // feel cluttered, so we trade persistence for a clean default each visit.
  const [doneExpanded, setDoneExpanded] = useState(false);
  // spec-365 sol-6: the board's drag-and-drop state machine lives in
  // useSpecBoard — drag/hover state plus the start/end/over/drop handlers,
  // including the optimistic updateDocStatus with rollback, the
  // board.phase_drag telemetry, the read-only guard, and the Done auto-expand.
  const {
    draggingId,
    dragOverColumn,
    setDragOverColumn,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDrop,
  } = useSpecBoard({ docs, setDocs, canWrite, setDoneExpanded });

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

  // spec-521 t-4 (ac-4): archiving now goes through a real confirm that ASKS WHY and
  // states the actual consequence — Claude stops reading the Spec entirely, not just
  // "it'll be hidden from the board". The old bare window.confirm carried neither.
  // The optimistic removal moved into onArchived, which only fires once the request
  // succeeded, so a failure no longer needs a rollback (the dialog reports it inline
  // instead of a window.alert).
  const handleArchived = useCallback((docId: string) => {
    setDocs((prev) => prev.filter((d) => d.id !== docId));
  }, []);

  const buildMenuItems = useCallback(
    (doc: DocSummary): SpecMenuItem[] => {
      const items: SpecMenuItem[] = [
        { label: 'Rename', onClick: () => setRenameDoc(doc) },
        { label: 'Share', onClick: () => setShareDocId(doc.id) },
        { label: 'Move to another memex', onClick: () => setMoveDoc(doc), separatorBefore: true },
        { label: 'Archive', onClick: () => setArchiveDoc(doc), danger: true, separatorBefore: true },
      ];
      return items;
    },
    [],
  );

  // spec-482 (dec-4, ac-24): the create modal — shared by the ?new=1 onboarding
  // deep-link and the board's "+ New Spec" button. Only the onboarding entry sets
  // landOnCreate, so it auto-lands the user on the created Spec (matching the hero
  // path); the "+ New Spec" button keeps spec-230's manual "Open Spec" footer.
  const newSpecModal = (
    <NewSpecModal
      open={modalOpen}
      onClose={() => {
        setModalOpen(false);
        setLandOnCreate(false);
      }}
      openOnCreate={landOnCreate}
    />
  );

  // spec-482 follow-up: the ?new=1 onboarding entry auto-opens the create modal to LAND
  // the user directly on the new Spec. Render it over a PLAIN page — never the board
  // (spinner + Kanban) behind it — so the create→land hop doesn't flash the specs board
  // on the way to the Spec. The board's own "+ New Spec" button never sets landOnCreate,
  // so it's unaffected (its modal still opens over the already-rendered board). On create,
  // the modal navigates straight to /specs/<handle>; on cancel, landOnCreate clears and the
  // board renders below as usual.
  if (landOnCreate && modalOpen) {
    return <div className="min-h-screen bg-page">{newSpecModal}</div>;
  }

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
  for (const d of docs) {
    // doc-12 t-13: archived Specs are always hidden from the kanban (the
    // server already filters them out by default, but defending here keeps
    // the contract local).
    if (d.archivedAt) continue;
    // spec-409 (ac-15): when the "Code-grounded only" filter is on, hide Specs
    // that are not grounded in code.
    if (groundedOnly && !d.groundedInCode) continue;
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
              {/* spec-447: when a non-"all" assignee is active the control is
                  accented (and flagged aria-invalid=false→data attr) so a
                  filtered board reads as filtered at a glance, not just in the
                  URL — the persisted filter must never masquerade as unfiltered. */}
              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                aria-label="Filter by assignee"
                data-active={assigneeFilter !== 'all'}
                className={`rounded-sm px-1.5 py-1 text-xs cursor-pointer ${
                  assigneeFilter !== 'all'
                    ? 'bg-accent/10 border border-accent text-accent'
                    : 'bg-surface border border-edge-subtle text-primary'
                }`}
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
            {/* spec-409 (ac-15): "Code-grounded only" header toggle — narrows the
                board to Specs whose decisions have been verified against the code.
                URL-reflected (?grounded=1) so the filtered board is shareable. */}
            <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={groundedOnly}
                onChange={(e) => setGroundedOnly(e.target.checked)}
                className="cursor-pointer"
                data-testid="grounded-only-filter"
              />
              Code-grounded only
            </label>
            {canWrite && (
              <Button onClick={() => setModalOpen(true)}>
                + New Spec
              </Button>
            )}
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
          URL (?tags=) so a filtered board is shareable.
          spec-447: a single "Clear filters" resets ALL three board filters
          (assignee / tags / grounded) in one action. It appears only when at
          least one filter is active — so its mere presence is itself a signal
          the board is filtered, not just the accented controls. */}
      <div className="flex-none mb-4 flex items-start gap-3">
        <TagFilter selected={tagFilter} onChange={setTagFilter} />
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearAllFilters}
            data-testid="clear-all-filters"
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 px-2 py-1 text-xs text-accent hover:bg-accent/10 hover:border-accent transition-colors"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span>Clear filters</span>
          </button>
        )}
        {/* spec-521 t-4 (ac-5): the way TO the archive. A link out of the board, not
            a column on it — archived work belongs out of the way. Pushed right so it
            never competes with the filters. */}
        <Link
          to={tenantPath('/specs/archive')}
          data-testid="archive-view-link"
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-primary hover:border-accent transition-colors"
        >
          Archived specs
        </Link>
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
            className="flex-1 min-w-56"
            onAddSpec={col.id === 'draft' ? () => setModalOpen(true) : undefined}
          />
        ))}
        {/* Done rail (dec-5): collapsed by default, click to expand. While a
            drag is hovering the rail, auto-expand so the user can see what
            they're dropping into; reverts to collapsed when the drag ends or
            leaves (handleDrop / handleDragEnd / dragLeave clear dragOverColumn).
            Drop targets stay live in the collapsed state too. */}
        {(doneExpanded || (draggingId !== null && dragOverColumn === 'done')) ? (
          <div className="flex-1 min-w-56 flex flex-col min-h-0">
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

      {/* The create modal (defined above). Rendered here over the board for the
          "+ New Spec" flow; the ?new=1 onboarding entry short-circuits above and
          renders it over a plain page instead (no board flash). SpecList renders under
          a tenant route, so openSpec's tenantPath('/specs/<handle>') fallback resolves. */}
      {newSpecModal}
      {shareDocId && <ShareModal docId={shareDocId} onClose={() => setShareDocId(null)} />}
      {archiveDoc && (
        <ArchiveSpecDialog
          docId={archiveDoc.id}
          title={archiveDoc.title}
          onClose={() => setArchiveDoc(null)}
          onArchived={() => handleArchived(archiveDoc.id)}
        />
      )}
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
