// spec-418 t-5 + t-6 — the Manage-tags surface. A Specs-board sub-surface at
// /:ns/:mx/specs/tags (dec-1), reached from the SINGLE entry point: the "Manage
// tags" row in the TagFilter dropdown. All-member access — there is NO admin gate
// [per std-4]: org membership alone grants access to every Memex in the org.
//
// t-5 built STRUCTURE + list + search + counts. t-6 wires the three curation
// dialogs (create / rename / delete), the full UX state set (empty / loading
// skeleton / optimistic-with-revert / server-error / named post-delete toast),
// keyboard/focus a11y, and LIVE refresh: the surface subscribes to the shared
// useDocChangeStream so a rename/delete anywhere (per-Spec `document` events,
// dec-4) refreshes it with no manual reload — the hook's 200ms debounce coalesces
// a fan-out burst into ONE refetch (proven in useDocChangeStream.test.tsx).
//
// Copy is minimal (dec-6 / ac-23/ac-24): NO standing description paragraph under
// the title (guidance sits behind an ⓘ), and the dialogs carry no descriptive
// sub-headers — only load-bearing text (block reasons, the delete blast radius).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchMemexTagsWithCounts,
  createCatalogueTag,
  renameCatalogueTag,
  deleteCatalogueTag,
  type TagWithCount,
} from '../api/docs';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui';
import { TagChip } from '../components/TagChip';
import { TagCreateDialog } from '../components/TagCreateDialog';
import { TagRenameDialog } from '../components/TagRenameDialog';
import { TagDeleteDialog } from '../components/TagDeleteDialog';
import { formatTagString } from '../components/TagDialogShell';

// A tag matches the query when its scope OR value contains the (lowercased) query
// substring — so both "priority" (scope) and "high" (value) narrow the list.
function matchesQuery(query: string, t: TagWithCount): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (t.scope?.toLowerCase().includes(q) ?? false) || t.value.toLowerCase().includes(q)
  );
}

// The catalogue grouped by scope for rendering: scoped groups first (alphabetical
// by scope name), then the flat/unscoped group last. Tags within every group are
// alphabetical by value. The server already orders scope-then-value; we re-sort
// defensively so the surface is stable regardless of the response order.
interface TagGroup {
  /** The scope name, or null for the flat/unscoped group. */
  scope: string | null;
  tags: TagWithCount[];
}

function groupByScope(tags: TagWithCount[]): TagGroup[] {
  const byScope = new Map<string | null, TagWithCount[]>();
  for (const t of tags) {
    const list = byScope.get(t.scope) ?? [];
    list.push(t);
    byScope.set(t.scope, list);
  }
  const byValue = (a: TagWithCount, b: TagWithCount) =>
    a.value.localeCompare(b.value, undefined, { sensitivity: 'base' });

  const scoped = [...byScope.keys()]
    .filter((s): s is string => s !== null)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((scope) => ({ scope, tags: [...byScope.get(scope)!].sort(byValue) }));

  const flat = byScope.has(null)
    ? [{ scope: null, tags: [...byScope.get(null)!].sort(byValue) }]
    : [];

  return [...scoped, ...flat];
}

// Which curation dialog is open (only ever one at a time — they're modal).
type DialogState =
  | { mode: 'create' }
  | { mode: 'rename'; tag: TagWithCount }
  | { mode: 'delete'; tag: TagWithCount }
  | null;

export function ManageTags() {
  const [tags, setTags] = useState<TagWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<string | null>(null);

  // load() drives the first render (skeleton → list); `silent` refetches WITHOUT
  // flipping back to the skeleton, so a live SSE-driven refresh updates the rows
  // in place rather than blanking the surface on every change.
  const load = useCallback((opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    fetchMemexTagsWithCounts()
      .then((data) => {
        setTags(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load tags'))
      .finally(() => {
        if (!opts?.silent) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // LIVE REFRESH (ac-7/ac-17): a single subscription with ONE coalesced callback.
  // A rename/delete elsewhere fans out per-Spec `document` events (dec-4); the
  // hook's 200ms debounce collapses the burst into this ONE silent refetch — the
  // surface never refetches per-event.
  const refetch = useCallback(() => load({ silent: true }), [load]);
  useDocChangeStream(null, refetch);

  // Auto-dismiss the post-delete confirmation toast.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  // ── Optimistic curation handlers (ac-36) ──────────────────────────────────
  // Each updates the list IMMEDIATELY, then confirms with the server. On failure
  // it reverts to the pre-mutation snapshot and re-throws so the open dialog can
  // surface the server's plain reason and stay open to retry (revert-with-reason).

  const handleCreate = useCallback(
    async (input: { scope: string | null; value: string }) => {
      const snapshot = tags;
      const tempId = `temp-${Date.now()}`;
      const temp: TagWithCount = {
        id: tempId,
        memexId: snapshot[0]?.memexId ?? '',
        scope: input.scope,
        value: input.value,
        createdAt: new Date().toISOString(),
        assignedCount: 0,
      };
      setTags([...snapshot, temp]);
      try {
        const created = await createCatalogueTag(input);
        // Swap the placeholder for the real row (real id, starts at 0 Specs).
        setTags((cur) => cur.map((t) => (t.id === tempId ? { ...created, assignedCount: 0 } : t)));
      } catch (err) {
        setTags(snapshot);
        throw err;
      }
    },
    [tags],
  );

  const handleRename = useCallback(
    async (tag: TagWithCount, input: { scope: string | null; value: string }) => {
      const snapshot = tags;
      setTags(snapshot.map((t) => (t.id === tag.id ? { ...t, scope: input.scope, value: input.value } : t)));
      try {
        const updated = await renameCatalogueTag(tag.id, input);
        setTags((cur) => cur.map((t) => (t.id === tag.id ? { ...t, ...updated } : t)));
      } catch (err) {
        setTags(snapshot);
        throw err;
      }
    },
    [tags],
  );

  const handleDelete = useCallback(
    async (tag: TagWithCount) => {
      const snapshot = tags;
      const n = tag.assignedCount;
      setTags(snapshot.filter((t) => t.id !== tag.id));
      try {
        await deleteCatalogueTag(tag.id);
        // Named post-delete confirmation (ac-36) — the exact tag + its blast radius.
        setToast(`Deleted '${formatTagString(tag)}' from ${n} Spec${n === 1 ? '' : 's'}`);
      } catch (err) {
        setTags(snapshot);
        throw err;
      }
    },
    [tags],
  );

  const visible = useMemo(() => tags.filter((t) => matchesQuery(query, t)), [tags, query]);
  const groups = useMemo(() => groupByScope(visible), [visible]);
  // Scale the count bar against the busiest tag so the bars read as a comparison,
  // not an absolute width. Guard the empty case so we never divide by zero.
  const maxCount = useMemo(
    () => tags.reduce((m, t) => Math.max(m, t.assignedCount), 0),
    [tags],
  );

  return (
    // Full-width header (breadcrumb + title left, actions right) matches the Specs
    // board so the breadcrumb sits in the same place; the list below is constrained
    // to a centered column (dec-6: calm, not stretched edge-to-edge).
    <div className="px-6 py-6 space-y-6">
      {/* Header carries only the breadcrumb + title (matches the Specs board); the
          New-tag / ⓘ actions live on the toolbar row with search, inside the column. */}
      <PageHeader title="Tags" />

      <div className="max-w-5xl mx-auto space-y-6">
      {/* Toolbar: search on the left, ⓘ + New tag on the right — always rendered so
          the empty state can still mint the first tag (search hides until tags exist). */}
      <div className="flex items-center justify-between gap-2">
        {tags.length > 0 ? (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tags…"
            aria-label="Search tags"
            data-testid="manage-tags-search"
            className="text-xs px-3 py-1.5 w-56 rounded-sm border border-edge bg-transparent text-primary placeholder:text-muted focus:outline-hidden focus:border-edge-strong"
          />
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {/* ⓘ guidance affordance — the only place copy lives (dec-6/ac-23). */}
          <button
            type="button"
            data-testid="manage-tags-info"
            aria-label="About tags"
            aria-expanded={showInfo}
            onClick={() => setShowInfo((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-edge-subtle text-muted transition-colors hover:text-primary hover:border-edge"
          >
            <span aria-hidden="true" className="text-sm font-serif italic">
              i
            </span>
          </button>
          {/* "New tag" — mints a catalogue tag (dec-7). */}
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="manage-tags-new"
            onClick={() => setDialog({ mode: 'create' })}
          >
            + New tag
          </Button>
        </div>
      </div>

      {showInfo && (
        <p data-testid="manage-tags-guidance" className="text-xs text-muted">
          Tags organise Specs. A scoped tag (<code>priority::high</code>) is
          mutually exclusive within its scope; a flat tag (<code>bug</code>) is not.
          Renaming or deleting a tag updates every Spec that carries it.
        </p>
      )}

      {loading ? (
        // Loading skeleton (ac-34): shimmer rows in two scope-group stubs until the
        // first data arrives. aria-hidden — a screen reader hears nothing until rows exist.
        <div data-testid="manage-tags-skeleton" className="space-y-6" aria-hidden="true">
          {[0, 1].map((g) => (
            <div key={g} className="space-y-2">
              <div className="h-3 w-24 rounded-sm bg-overlay animate-pulse" />
              <ul className="divide-y divide-edge-subtle border border-edge-subtle rounded-lg">
                {[0, 1, 2].map((r) => (
                  <li key={r} className="flex items-center gap-3 px-3 py-2">
                    <div className="h-5 w-20 rounded-full bg-overlay animate-pulse" />
                    <div className="h-1.5 flex-1 max-w-40 rounded-full bg-overlay animate-pulse" />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : error ? (
        <div
          data-testid="manage-tags-error"
          className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text"
        >
          Failed to load tags: {error}
        </div>
      ) : tags.length === 0 ? (
        // Empty state (ac-34): a brief line + a path-based link back to the board
        // where a Spec is created (tags are born on Specs). No MCP-only step (std-34).
        <div
          data-testid="manage-tags-empty"
          className="border border-edge-subtle rounded-lg p-8 text-center bg-surface/40 space-y-2"
        >
          <p className="text-sm text-secondary">No tags yet. Tags come from Specs.</p>
          <Link
            to=".."
            data-testid="manage-tags-empty-cta"
            className="inline-block text-sm text-accent hover:underline"
          >
            Create a Spec
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <div
          data-testid="manage-tags-search-empty"
          className="text-sm text-secondary py-12 text-center"
        >
          No tags match “{query.trim()}”.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div
              key={group.scope ?? ' flat'}
              data-testid={group.scope === null ? 'tag-group-flat' : 'tag-group'}
              data-scope={group.scope ?? ''}
            >
              {/* A real scope gets the accent hue the scoped-tag chips use — one visual
                  language for "scope". The no-scope bucket is the ABSENCE of a scope, so
                  it must NOT borrow that accent (it would undermine the signal); it uses a
                  plain-but-legible secondary tone instead. Both read clearly in dark mode. */}
              <h2
                className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                  group.scope === null ? 'text-secondary' : 'text-accent'
                }`}
              >
                {group.scope ?? 'No scope'}
              </h2>
              <ul className="divide-y divide-edge-subtle border border-edge-subtle rounded-lg">
                {group.tags.map((t) => (
                  <TagRow
                    key={t.id}
                    tag={t}
                    maxCount={maxCount}
                    onRename={() => setDialog({ mode: 'rename', tag: t })}
                    onDelete={() => setDialog({ mode: 'delete', tag: t })}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      </div>

      {/* Post-delete confirmation toast (ac-36). role=status so it's announced. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          data-testid="manage-tags-toast"
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 rounded-lg border border-edge bg-panel px-4 py-2 text-sm text-primary shadow-2xl"
        >
          {toast}
        </div>
      )}

      {dialog?.mode === 'create' && (
        <TagCreateDialog
          existingTags={tags}
          onCreate={handleCreate}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.mode === 'rename' && (
        <TagRenameDialog
          tag={dialog.tag}
          existingTags={tags}
          onRename={(input) => handleRename(dialog.tag, input)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.mode === 'delete' && (
        <TagDeleteDialog
          tag={dialog.tag}
          onDelete={() => handleDelete(dialog.tag)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

// A single catalogue row: the reused chip, the assigned-count bar + number, and
// the two per-row actions. The buttons are real <button>s (keyboard-focusable via
// Tab, invocable by Enter/Space); each opens its dialog through the surface.
function TagRow({
  tag,
  maxCount,
  onRename,
  onDelete,
}: {
  tag: TagWithCount;
  maxCount: number;
  onRename: () => void;
  onDelete: () => void;
}) {
  const pct = maxCount > 0 ? Math.round((tag.assignedCount / maxCount) * 100) : 0;
  return (
    <li data-testid="tag-row" className="flex items-center gap-3 px-3 py-2">
      <div className="flex-none">
        <TagChip tag={tag} />
      </div>

      {/* Assigned-count: a proportional bar + the number, read as "how used". */}
      <div className="ml-2 flex flex-1 items-center gap-2 min-w-0">
        <div
          data-testid="tag-count-bar"
          className="h-1.5 max-w-40 flex-1 overflow-hidden rounded-full bg-overlay"
          role="presentation"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <span
          data-testid="tag-count"
          className="flex-none w-8 text-right text-xs tabular-nums text-secondary"
          title={`${tag.assignedCount} Spec${tag.assignedCount === 1 ? '' : 's'}`}
        >
          {tag.assignedCount}
        </span>
      </div>

      <div className="flex flex-none items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="tag-rename"
          aria-label={`Rename ${tag.scope ? `${tag.scope}::${tag.value}` : tag.value}`}
          onClick={onRename}
        >
          Rename
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="tag-delete"
          aria-label={`Delete ${tag.scope ? `${tag.scope}::${tag.value}` : tag.value}`}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}
