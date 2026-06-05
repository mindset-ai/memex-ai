// Issues — the Memex-level Issues page (spec-158 t-4).
//
// A read-only roll-up of every OPEN issue across the Memex, fetched from
// GET /api/<ns>/<mx>/issues-list (the spec-158 t-3 endpoint) and rendered
// GROUPED under the parent Spec it was raised against (ac-1 / ac-7). It is the
// cross-Spec peer of the per-Spec IssuePanel (the Issues tab on a Spec view):
// same issue rows, a Memex-wide vantage.
//
// What this page owns:
//   - Filter bar (ac-2 / ac-10 / ac-12 / ac-13): scope (Mine default / Everyone),
//     phase checkboxes (draft/plan/build/verify/done, all on), type checkboxes
//     (bug/todo, both on). Every control is reflected in the URL query string so
//     a filtered view is shareable / survives reload (mirrors Pulse's `?spec=`).
//   - Grouping: the server orders rows by most-recent issue activity, so the
//     first row of each Spec already sorts the freshest Spec to the top; we group
//     in first-seen order to preserve that (ac-7).
//   - Row anatomy: a type pill (bug/todo, the IssuePanel idiom), the `issue-N`
//     handle, the title, a relative created time (TimeAgo, exact on hover), and a
//     right-hand actions placeholder a follow-up task fills (Convert / Close).
//   - Row click → the EXISTING `specs/:id/issues/:issueId` deep-link (ac-17);
//     no highlight machinery here — DocDocument/IssuePanel already own the
//     scroll-into-view + ring pulse.
//   - Empty states: a Mine-scope-empty nudge that offers Everyone, and a calm
//     all-clear when there are genuinely zero open issues.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { fetchMemexIssues, updateIssueStatusApi, type MemexIssue } from '../api/client';
import type { IssueStatus, IssueType } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { Badge, Button } from '../components/ui';
import { NewSpecModal } from '../components/NewSpecModal';
import { SpecMenu } from '../components/SpecMenu';
import { ScopeToggle, type PulseScope } from '../components/pulse/ScopeToggle';
import { TimeAgo } from '../components/pulse/TimeAgo';
import { tenantPathFor } from '../utils/tenantUrl';
import { phaseDisplayName } from '../utils/phaseDisplay';

// The phase set the filter exposes, 1:1 with the server's SpecPhase (the
// documents.status values the Spec rename settled on). All checked by default.
const PHASES = ['draft', 'plan', 'build', 'verify', 'done'] as const;
// spec-164 (scope ac-7): `done` ships UNCHECKED by default — issues on done
// specs are usually resolved-or-moot, so surfacing them is an explicit opt-in.
// Any other selection (including done on) serialises to the ?phases= param.
const DEFAULT_PHASES = ['draft', 'plan', 'build', 'verify'] as const;
type Phase = (typeof PHASES)[number];

const TYPES: readonly IssueType[] = ['bug', 'todo'];
const TYPE_LABEL: Record<IssueType, string> = { bug: 'bug', todo: 'todo' };

// The page's scope vocabulary matches the Pulse ScopeToggle ('me' | 'everyone'),
// but the issues-list endpoint speaks 'mine' | 'all'. Map at the boundary so the
// reused control stays as-is.
function scopeToParam(scope: PulseScope): 'mine' | 'all' {
  return scope === 'me' ? 'mine' : 'all';
}

// ── URL <-> filter state. Defaults (ac-2/ac-10/ac-12/ac-13): scope 'me', every
// phase on, every type on. An absent param reads as "all selected" so a bare
// /issues URL shows the full default view; a present (possibly empty) param is
// the user's explicit selection and round-trips verbatim. ──────────────────────

function parseScope(params: URLSearchParams): PulseScope {
  // Only the explicit widening reads as 'everyone'; anything else (absent / typo)
  // falls back to the safe narrow default, mirroring the server's scope guard.
  return params.get('scope') === 'everyone' ? 'everyone' : 'me';
}

// Read a CSV multi-select param against a known vocabulary. Absent ⇒ the given
// DEFAULT set; present ⇒ exactly the recognised tokens it lists (so an empty
// param means "none selected" and round-trips as such).
function parseSet<T extends string>(
  params: URLSearchParams,
  key: string,
  all: readonly T[],
  defaults: readonly T[] = all,
): Set<T> {
  const raw = params.get(key);
  if (raw === null) return new Set(defaults);
  const valid = new Set<string>(all);
  return new Set(
    raw
      .split(',')
      .map((t) => t.trim())
      .filter((t): t is T => valid.has(t)),
  );
}

export function IssuesList() {
  const { namespace, memex } = useParams<{ namespace: string; memex: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive filter state straight from the URL so the query string is the single
  // source of truth (shareable / reload-safe). Toggling a control rewrites the
  // URL, which re-derives state — no separate useState to keep in sync.
  const scope = parseScope(searchParams);
  const phases = useMemo(
    () => parseSet(searchParams, 'phases', PHASES, DEFAULT_PHASES),
    [searchParams],
  );
  const types = useMemo(() => parseSet(searchParams, 'types', TYPES), [searchParams]);

  const patchParams = useCallback(
    (mut: (next: URLSearchParams) => void) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mut(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setScope = useCallback(
    (next: PulseScope) => {
      // 'me' is the default — drop the param rather than pin the default value.
      patchParams((p) => (next === 'everyone' ? p.set('scope', 'everyone') : p.delete('scope')));
    },
    [patchParams],
  );

  const togglePhase = useCallback(
    (phase: Phase) => {
      const next = new Set(phases);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      // The DEFAULT set (done off) keeps the URL clean — omit the param when
      // the selection matches it; otherwise serialise the explicit selection
      // (even empty).
      const isDefault =
        next.size === DEFAULT_PHASES.length && DEFAULT_PHASES.every((ph) => next.has(ph));
      patchParams((p) =>
        isDefault ? p.delete('phases') : p.set('phases', [...next].join(',')),
      );
    },
    [phases, patchParams],
  );

  const toggleType = useCallback(
    (type: IssueType) => {
      const next = new Set(types);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      patchParams((p) =>
        next.size === TYPES.length ? p.delete('types') : p.set('types', [...next].join(',')),
      );
    },
    [types, patchParams],
  );

  // ── Fetch. Re-runs whenever the resolved filter values change; the endpoint
  // does the scope / phase / type narrowing server-side, so we hand it exactly
  // the active selection. An empty phase / type selection sends an empty CSV,
  // which the server reads as "no narrowing" — so we instead skip the round-trip
  // and render an empty list locally (an empty selection can only be empty). ──
  const [items, setItems] = useState<MemexIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stable cache keys for the effect deps (Sets aren't referentially stable).
  const phasesKey = [...phases].sort().join(',');
  const typesKey = [...types].sort().join(',');

  // ── Loader. Pulled out of the effect so an inline action (spec-158 t-5 — close
  // an issue, or a confirmed Convert-to-Spec) can refetch the current filter view.
  // Captures the live filter values via a ref so the callback identity stays
  // stable (a re-created `load` would needlessly retrigger the fetch effect). ──
  const filtersRef = useRef({ scope, phases, types });
  filtersRef.current = { scope, phases, types };

  const load = useCallback(async () => {
    const { scope, phases, types } = filtersRef.current;
    // An empty phase or type selection can match nothing — short-circuit rather
    // than ask the server (which would treat empty as "all").
    if (phases.size === 0 || types.size === 0) {
      setItems([]);
      setError(null);
      return;
    }
    try {
      const rows = await fetchMemexIssues({
        scope: scopeToParam(scope),
        // Only send a filter param when it's a strict subset; the full set is the
        // server's default, so omitting it is equivalent and keeps the wire terse.
        phases: phases.size < PHASES.length ? [...phases] : undefined,
        types: types.size < TYPES.length ? [...types] : undefined,
      });
      setItems(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (phases.size === 0 || types.size === 0) {
      setItems([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setItems(null);
    fetchMemexIssues({
      scope: scopeToParam(scope),
      phases: phases.size < PHASES.length ? [...phases] : undefined,
      types: types.size < TYPES.length ? [...types] : undefined,
    })
      .then((rows) => {
        if (!cancelled) {
          setItems(rows);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
    // phasesKey/typesKey stand in for the Sets; scope is a primitive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, phasesKey, typesKey, phases.size, types.size]);

  // ── Inline row actions (spec-158 t-5, dec-6). ─────────────────────────────
  // Close (Resolve / Won't fix): picking either from the ⋯ menu first raises an
  // OK/Cancel confirmation dialog — closing an issue from a list row is easy to
  // fat-finger and (while reversible server-side) immediately removes the row.
  // Confirming reuses the EXISTING resolve path (updateIssueStatusApi) every
  // other surface uses; on success drop the row from the open list optimistically
  // (the page only shows open issues, so a resolved/wont_fix issue no longer
  // belongs). A failure leaves the row in place and surfaces the error.
  const [pendingClose, setPendingClose] = useState<{
    issue: MemexIssue;
    status: IssueStatus;
  } | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);

  const requestClose = useCallback((issue: MemexIssue, status: IssueStatus) => {
    setPendingClose({ issue, status });
  }, []);

  const confirmClose = useCallback(async () => {
    if (!pendingClose) return;
    setCloseBusy(true);
    try {
      await updateIssueStatusApi(pendingClose.issue.id, pendingClose.status);
      setItems((prev) => (prev ? prev.filter((i) => i.id !== pendingClose.issue.id) : prev));
      setPendingClose(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPendingClose(null);
    } finally {
      setCloseBusy(false);
    }
  }, [pendingClose]);

  // Convert to Spec: open the EXISTING NewSpecModal prefilled with the Issue's
  // content + its canonical ref. The Issue flips to converted ONLY on a confirmed
  // create (onCreated, fired off the doc_created detection) — at which point we
  // refetch so the now-converted Issue drops out, and raise a confirmation dialog
  // naming the new Spec. Abandoning the modal leaves the Issue open and its row
  // in place.
  const [convertIssue, setConvertIssue] = useState<MemexIssue | null>(null);
  const [converted, setConverted] = useState<{ handle: string; title: string } | null>(null);

  const convertPrefill = useMemo(() => {
    if (!convertIssue || !namespace || !memex) return undefined;
    const issueRef = `${namespace}/${memex}/specs/${convertIssue.spec.handle}/issues/issue-${convertIssue.seq}`;
    return {
      title: convertIssue.title,
      // MemexIssue is the list shape — no body field — so the Issue title seeds
      // the composer; the user elaborates the rest. The ref still carries the
      // promote lineage so the Issue → converted on creation.
      body: '',
      promoteFromIssueRef: issueRef,
    };
  }, [convertIssue, namespace, memex]);

  // ── Group rows under their parent Spec, preserving the server's most-recent-
  // activity order (the first row of each Spec is its freshest issue, so groups
  // come out freshest-first when we record them in first-seen order, ac-7). ──
  const groups = useMemo(() => {
    const byDoc = new Map<string, { spec: MemexIssue['spec']; issues: MemexIssue[] }>();
    for (const item of items ?? []) {
      let group = byDoc.get(item.spec.docId);
      if (!group) {
        group = { spec: item.spec, issues: [] };
        byDoc.set(item.spec.docId, group);
      }
      group.issues.push(item);
    }
    return [...byDoc.values()];
  }, [items]);

  return (
    <div className="h-full flex flex-col px-6 py-6">
      <PageHeader title="Issues" actions={<ScopeToggle value={scope} onChange={setScope} />} />

      {/* Filter bar — phase + type checkboxes. The scope control rides in the
          header beside the title (PageHeader actions), matching Pulse. */}
      <div
        className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-5 flex-none text-xs"
        data-testid="issues-filter-bar"
      >
        <CheckboxGroup label="Phase">
          {PHASES.map((phase) => (
            <FilterCheckbox
              key={phase}
              testid={`issues-phase-${phase}`}
              label={phaseDisplayName(phase)}
              checked={phases.has(phase)}
              onChange={() => togglePhase(phase)}
            />
          ))}
        </CheckboxGroup>
        <CheckboxGroup label="Type">
          {TYPES.map((type) => (
            <FilterCheckbox
              key={type}
              testid={`issues-type-${type}`}
              label={TYPE_LABEL[type]}
              checked={types.has(type)}
              onChange={() => toggleType(type)}
            />
          ))}
        </CheckboxGroup>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <div className="rounded-md border border-status-danger-border bg-status-danger-bg px-3 py-2 text-xs text-status-danger-text">
            {error}
          </div>
        ) : items === null ? (
          <div className="px-2 py-10 text-sm text-muted">Loading issues…</div>
        ) : groups.length === 0 ? (
          <EmptyState scope={scope} onShowEveryone={() => setScope('everyone')} />
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <SpecGroup
                key={group.spec.docId}
                spec={group.spec}
                issues={group.issues}
                namespace={namespace}
                memex={memex}
                onClose={requestClose}
                onConvert={setConvertIssue}
              />
            ))}
          </div>
        )}
      </div>

      {/* Convert to Spec (spec-158 t-5): the EXISTING NewSpecModal, prefilled
          from the chosen Issue + its canonical ref. The Issue flips to converted
          only on a confirmed create — onCreated refetches so it drops out; closing
          the modal leaves it open. */}
      <NewSpecModal
        open={convertIssue !== null && convertPrefill !== undefined}
        onClose={() => setConvertIssue(null)}
        prefill={convertPrefill}
        onCreated={(info) => {
          setConvertIssue(null);
          setConverted({ handle: info.handle, title: info.title });
          void load();
        }}
      />

      {/* Close confirmation (OK/Cancel) — picking Resolve / Won't fix from the
          row menu confirms before mutating. */}
      {pendingClose && (
        <ConfirmDialog
          heading={
            pendingClose.status === 'resolved'
              ? 'Resolve this issue?'
              : "Mark this issue as won't fix?"
          }
          body={
            <>
              <span className="font-mono text-xs">issue-{pendingClose.issue.seq}</span>
              {' — '}
              {pendingClose.issue.title}
              <br />
              It will be removed from the open issues list.
            </>
          }
          confirmLabel={pendingClose.status === 'resolved' ? 'Resolve' : "Won't fix"}
          busy={closeBusy}
          onConfirm={() => void confirmClose()}
          onCancel={() => setPendingClose(null)}
        />
      )}

      {/* Conversion confirmation — fires only off the confirmed doc_created
          detection, naming the new Spec, with a jump-off to open it. */}
      {converted && (
        <ConfirmDialog
          heading="Issue converted to Spec"
          body={
            <>
              <span className="font-mono text-xs">{converted.handle}</span>
              {' — '}&ldquo;{converted.title}&rdquo; was created. The issue is now marked as
              converted and will resolve automatically when the Spec reaches done.
            </>
          }
          confirmLabel="Open Spec"
          onConfirm={() => {
            if (namespace && memex) {
              navigate(tenantPathFor(namespace, memex, `/specs/${converted.handle}`));
            }
            setConverted(null);
          }}
          cancelLabel="Done"
          onCancel={() => setConverted(null)}
        />
      )}
    </div>
  );
}

// Minimal OK/Cancel confirmation dialog — mirrors MemexVisibilityConfirmDialog's
// shell (portal, Escape/backdrop cancel) without the visibility-specific copy.
function ConfirmDialog({
  heading,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onCancel,
}: {
  heading: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-edge">
          <h2 className="text-base font-semibold text-heading">{heading}</h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-secondary">{body}</p>
        </div>
        <div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button type="button" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// One parent-Spec heading (title + phase badge) with its open issues beneath it.
function SpecGroup({
  spec,
  issues,
  namespace,
  memex,
  onClose,
  onConvert,
}: {
  spec: MemexIssue['spec'];
  issues: MemexIssue[];
  namespace: string | undefined;
  memex: string | undefined;
  onClose: (issue: MemexIssue, status: IssueStatus) => void;
  onConvert: (issue: MemexIssue) => void;
}) {
  const specHref =
    namespace && memex ? tenantPathFor(namespace, memex, `/specs/${spec.handle}`) : undefined;
  return (
    <section data-testid="issues-spec-group" data-spec-handle={spec.handle}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-mono text-muted">{spec.handle}</span>
        {specHref ? (
          <Link
            to={specHref}
            className="text-sm font-medium text-heading hover:text-primary truncate"
          >
            {spec.title}
          </Link>
        ) : (
          <span className="text-sm font-medium text-heading truncate">{spec.title}</span>
        )}
        {/* Reuse the canonical status → Badge mapping (statusStyles); the Spec's
            phase is just its doc status (draft/plan/build/verify/done). The Badge
            doesn't forward arbitrary props, so the test hook rides a wrapper. */}
        <span data-testid="issues-spec-phase" className="flex-none">
          <Badge status={spec.status} label={phaseDisplayName(spec.status)} />
        </span>
      </div>
      <div className="space-y-1.5">
        {issues.map((issue) => (
          <IssueRow
            key={issue.id}
            issue={issue}
            namespace={namespace}
            memex={memex}
            onClose={onClose}
            onConvert={onConvert}
          />
        ))}
      </div>
    </section>
  );
}

// One issue row: type pill · issue-N · title · time-ago — and the inline actions
// on the right (Convert to Spec + a Close menu offering Resolve / Won't fix,
// spec-158 t-5 / dec-6). Clicking the row (outside the actions area) follows the
// existing issue deep-link.
function IssueRow({
  issue,
  namespace,
  memex,
  onClose,
  onConvert,
}: {
  issue: MemexIssue;
  namespace: string | undefined;
  memex: string | undefined;
  onClose: (issue: MemexIssue, status: IssueStatus) => void;
  onConvert: (issue: MemexIssue) => void;
}) {
  const issueHandle = `issue-${issue.seq}`;
  const href =
    namespace && memex
      ? tenantPathFor(namespace, memex, `/specs/${issue.spec.handle}/issues/${issueHandle}`)
      : undefined;

  // The whole row is a link to the deep-link route (ac-17). The actions area
  // stops propagation so a follow-up Convert/Close click doesn't navigate.
  const inner = (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-edge-subtle bg-surface/50 hover:bg-card-hover transition-colors">
      {/* Type pill — same idiom as IssuePanel (bug → blocked/red, todo → archived). */}
      <Badge
        status={issue.type === 'bug' ? 'blocked' : 'archived'}
        label={TYPE_LABEL[issue.type]}
        className="flex-none"
      />
      <span className="flex-none text-xs font-mono text-muted">{issueHandle}</span>
      <span className="flex-1 min-w-0 text-sm truncate text-primary">{issue.title}</span>
      <TimeAgo value={issue.createdAt} className="flex-none text-xs text-muted" />
      {/* Inline actions (spec-158 t-5 / dec-6). A click inside must NOT navigate —
          stop it before it reaches the link. Convert to Spec opens the prefilled
          NewSpecModal; the ⋯ Close menu offers Resolve / Won't fix (the existing
          resolve path). Both reuse the per-Spec IssuePanel idioms. */}
      <div
        data-testid="issue-row-actions"
        className="flex-none flex items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          data-testid="issue-convert-spec"
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onConvert(issue);
          }}
          title="Promote this Issue into its own Spec"
        >
          Convert to Spec
        </Button>
        <SpecMenu
          ariaLabel="Close issue"
          size="sm"
          items={[
            {
              label: 'Resolve',
              onClick: () => onClose(issue, 'resolved'),
            },
            {
              label: "Won't fix",
              onClick: () => onClose(issue, 'wont_fix'),
            },
          ]}
        />
      </div>
    </div>
  );

  if (!href) {
    return (
      <div data-testid="issue-row" data-issue-handle={issueHandle} data-issue-type={issue.type}>
        {inner}
      </div>
    );
  }
  return (
    <Link
      to={href}
      data-testid="issue-row"
      data-issue-handle={issueHandle}
      data-issue-type={issue.type}
      className="block"
    >
      {inner}
    </Link>
  );
}

function CheckboxGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="font-medium uppercase tracking-wider text-muted">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

function FilterCheckbox({
  label,
  checked,
  onChange,
  testid,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  testid: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-secondary">
      <input
        type="checkbox"
        data-testid={testid}
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 rounded border-edge text-accent focus:ring-accent"
      />
      <span className="capitalize">{label}</span>
    </label>
  );
}

// Two empty states (ac per the Design & UX spec): under 'me' scope an empty list
// is usually a scoping artefact, so explain it and offer Everyone; a genuinely
// zero-open-issues Memex ('everyone' empty) gets a calm all-clear.
function EmptyState({
  scope,
  onShowEveryone,
}: {
  scope: PulseScope;
  onShowEveryone: () => void;
}) {
  if (scope === 'me') {
    return (
      <div data-testid="issues-empty-mine" className="px-2 py-12 text-center">
        <p className="text-sm text-primary">No open issues on Specs assigned to you.</p>
        <p className="text-xs text-muted mt-1">
          You're only seeing issues on your Specs. There may be more across the Memex.
        </p>
        <button
          type="button"
          data-testid="issues-empty-everyone"
          onClick={onShowEveryone}
          className="mt-3 text-sm text-secondary hover:text-primary underline"
        >
          Show everyone's issues
        </button>
      </div>
    );
  }
  return (
    <div data-testid="issues-empty-all" className="px-2 py-12 text-center">
      <p className="text-sm text-primary">No open issues. All clear.</p>
      <p className="text-xs text-muted mt-1">
        Bugs and todos raised against any Spec will show up here.
      </p>
    </div>
  );
}
