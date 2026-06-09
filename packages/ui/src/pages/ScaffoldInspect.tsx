// b-68 t-12 / t-13 / t-14: the Inspect page.
//
// Mounted under the tenant-scoped routes at `/scaffold`. Available to any
// signed-in user; UI degrades for non-admins (no Add / Toggle affordances).
// The page resolves the principal's Org from the current tenant membership
// and calls /api/orgs/:orgId/scaffold to load the merged base + Org payload.
//
// Layout (per s-7):
//   - Left rail: Overview · 5 phases · 4 gates.
//   - Main pane: switches on the selected node.
//
// The page deliberately does its own fetch via the api/scaffold client rather
// than relying on the doc-change SSE — scaffold updates ride a separate std-8
// bus channel that the React UI doesn't subscribe to today. Admin edits
// refetch the scaffold inline (the server cache is invalidated on the bus,
// so the next GET reflects the change).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { parseTenantFromPathname } from '../utils/tenantUrl';
import {
  fetchScaffold,
  createScaffoldAddition,
  toggleScaffoldAddition,
  type ScaffoldFetchResponse,
} from '../api/scaffold';
import { getOrgApi } from '../api/client';
import { ScaffoldExplainer } from '../components/scaffold/ScaffoldExplainer';
import { ScaffoldPhaseView } from '../components/scaffold/ScaffoldPhaseView';
import { ScaffoldGateView } from '../components/scaffold/ScaffoldGateView';
import { ScaffoldMatrix } from '../components/scaffold/ScaffoldMatrix';
import { ScaffoldButtonView } from '../components/scaffold/ScaffoldButtonView';
import { BASE_SCAFFOLD, type GuidanceBlock, type Phase, type Transition } from '@memex/shared';

type Selected =
  | { kind: 'overview' }
  | { kind: 'phase'; phase: Phase }
  | { kind: 'gate'; transition: Transition }
  | { kind: 'button'; buttonId: string }
  | { kind: 'matrix' };

const PHASES: Phase[] = ['draft', 'specify', 'build', 'verify', 'done'];
const TRANSITIONS: Transition[] = ['specify', 'build', 'verify', 'done'];

const TRANSITION_FOR_PHASE: Record<Phase, Transition | null> = {
  draft: 'specify',
  specify: 'build',
  build: 'verify',
  verify: 'done',
  done: null,
};

export function ScaffoldInspect() {
  const { session, token } = useAuth();
  const location = useLocation();

  const tenant = parseTenantFromPathname(location.pathname);
  const currentMembership = tenant
    ? session?.memberships.find(
        (m) => m.slug === tenant.namespace && m.memexSlug === tenant.memex,
      )
    : session?.memberships.find((m) => m.memexId === session?.currentMemexId);
  const isAdmin = currentMembership?.role === 'administrator';
  // spec-193 t-5: the memex this Inspect page is anchored to, for the per-memex
  // Scope control in the authoring editor. Null on org-level views with no
  // resolved memex (the editor then offers account-wide only).
  const currentMemexId = currentMembership?.memexId ?? null;
  const currentMemexLabel = tenant?.memex;

  const [orgId, setOrgId] = useState<string | null>(null);

  // Resolve the Org for the current tenant via `getOrgApi`. Failure (personal
  // Memex, namespace with no ownerOrgId, non-admin caller) is non-fatal: the
  // page falls back to BASE_SCAFFOLD with no Org overlays and hides admin
  // affordances. Per b-68 D-4, view is open to any active member; the failure
  // mode here only loses Org-specific content, not the page itself.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const org = await getOrgApi(token);
        if (cancelled) return;
        setOrgId(org.id);
      } catch {
        if (cancelled) return;
        setOrgId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Default to the universal base scaffold so the page renders even when no
  // Org resolves. When orgId becomes available, `load` swaps in the merged
  // (base + Org additions) payload.
  const baseFallback = useMemo<ScaffoldFetchResponse>(
    () => ({ base: BASE_SCAFFOLD, org: [] }),
    [],
  );
  const [data, setData] = useState<ScaffoldFetchResponse>(baseFallback);

  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const payload = await fetchScaffold(orgId);
      setData(payload);
    } catch {
      // Non-fatal: keep showing the base scaffold. Admin affordances stay
      // hidden because `canEdit` already requires a resolved orgId.
    }
  }, [orgId]);

  useEffect(() => {
    if (orgId) void load();
  }, [orgId, load]);

  // Edit requires both admin role AND a resolved Org. Either missing leaves
  // the surface read-only.
  const canEdit = !!isAdmin && !!orgId;

  const [selected, setSelected] = useState<Selected>({ kind: 'overview' });

  const orgBlocks = useMemo<readonly GuidanceBlock[]>(() => data?.org ?? [], [data]);

  const handleCreateAddition = useCallback(
    async (input: {
      target: GuidanceBlock['target'];
      text: string;
      rationale: string;
      emphasis?: GuidanceBlock['emphasis'];
      // spec-193 t-5: optional per-memex scope, set by the editor's Scope control.
      memexId?: string;
    }) => {
      if (!orgId) throw new Error('No Org resolved');
      await createScaffoldAddition(orgId, input);
      await load();
    },
    [orgId, load],
  );

  const handleToggleAddition = useCallback(
    async (id: string, enabled: boolean) => {
      if (!orgId) throw new Error('No Org resolved');
      await toggleScaffoldAddition(orgId, id, enabled);
      await load();
    },
    [orgId, load],
  );

  return (
    <div className="flex h-full overflow-hidden" data-testid="scaffold-inspect-page">
      {/* Left rail */}
      <nav
        data-testid="scaffold-left-rail"
        className="w-56 shrink-0 border-r border-default p-4 space-y-1 text-sm overflow-y-auto"
      >
        <RailLink
          label="Overview"
          active={selected.kind === 'overview'}
          onClick={() => setSelected({ kind: 'overview' })}
          testId="scaffold-rail-overview"
        />
        <div className="mt-3 mb-1 text-xs uppercase tracking-wide text-secondary">
          Phases
        </div>
        {PHASES.map((p) => (
          <RailLink
            key={p}
            label={p}
            active={selected.kind === 'phase' && selected.phase === p}
            onClick={() => setSelected({ kind: 'phase', phase: p })}
            testId={`scaffold-rail-phase-${p}`}
          />
        ))}
        <div className="mt-3 mb-1 text-xs uppercase tracking-wide text-secondary">
          Gates
        </div>
        {TRANSITIONS.map((t) => (
          <RailLink
            key={t}
            label={`→${t}`}
            active={selected.kind === 'gate' && selected.transition === t}
            onClick={() => setSelected({ kind: 'gate', transition: t })}
            testId={`scaffold-rail-gate-${t}`}
          />
        ))}
        {data.base.promptButtons.length > 0 ? (
          <>
            <div className="mt-3 mb-1 text-xs uppercase tracking-wide text-secondary">
              Prompt Buttons
            </div>
            {data.base.promptButtons.map((b) => (
              <RailLink
                key={b.id}
                label={b.label}
                active={selected.kind === 'button' && selected.buttonId === b.id}
                onClick={() => setSelected({ kind: 'button', buttonId: b.id })}
                testId={`scaffold-rail-button-${b.id}`}
              />
            ))}
          </>
        ) : null}
        <div className="mt-3 mb-1 text-xs uppercase tracking-wide text-secondary">
          Pivot
        </div>
        <RailLink
          label="Show full matrix"
          active={selected.kind === 'matrix'}
          onClick={() => setSelected({ kind: 'matrix' })}
          testId="scaffold-rail-matrix"
        />
      </nav>

      {/* Main pane — own its scroll so content past the viewport remains
          reachable. Inner wrapper caps the readable line length while the
          outer main keeps the scrollbar pinned to the right edge. */}
      <main className="flex-1 min-w-0 overflow-y-auto p-8">
        <div className="max-w-5xl">
        {selected.kind === 'overview' ? <ScaffoldExplainer /> : null}
        {selected.kind === 'phase' ? (
          <ScaffoldPhaseView
            phase={selected.phase}
            dataset={data.base}
            orgBlocks={orgBlocks}
            onSelectGate={() => {
              const t = TRANSITION_FOR_PHASE[selected.phase];
              if (t) setSelected({ kind: 'gate', transition: t });
            }}
            isAdmin={canEdit}
            onCreateAddition={canEdit ? handleCreateAddition : undefined}
            onToggleAddition={canEdit ? handleToggleAddition : undefined}
            currentMemexId={currentMemexId}
            currentMemexLabel={currentMemexLabel}
          />
        ) : null}
        {selected.kind === 'gate' ? (
          <ScaffoldGateView
            transition={selected.transition}
            dataset={data.base}
            orgBlocks={orgBlocks}
            isAdmin={canEdit}
            onCreateAddition={canEdit ? handleCreateAddition : undefined}
            onToggleAddition={canEdit ? handleToggleAddition : undefined}
            currentMemexId={currentMemexId}
            currentMemexLabel={currentMemexLabel}
          />
        ) : null}
        {selected.kind === 'button' ? (
          <ScaffoldButtonView
            buttonId={selected.buttonId}
            dataset={data.base}
            orgBlocks={orgBlocks}
            isAdmin={canEdit}
            onCreateAddition={canEdit ? handleCreateAddition : undefined}
            onToggleAddition={canEdit ? handleToggleAddition : undefined}
            currentMemexId={currentMemexId}
            currentMemexLabel={currentMemexLabel}
          />
        ) : null}
        {selected.kind === 'matrix' ? (
          <ScaffoldMatrix dataset={data.base} orgBlocks={orgBlocks} />
        ) : null}
        </div>
      </main>
    </div>
  );
}

function RailLink({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`block w-full text-left px-2 py-1 rounded ${
        active ? 'bg-muted/40 font-semibold' : 'hover:bg-muted/20'
      }`}
    >
      {label}
    </button>
  );
}
