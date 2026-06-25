// spec-343: the redesigned Scaffold Inspect/Extend surface.
//
// dec-1 — organised around the Spec lifecycle as a timeline spine, with the
// four forward gates as the connectors between phases. dec-2 — view = any
// active member, edit = administrator (UI-only; same routes/model as spec-68).
// The old flat left-rail (Overview + 5 phases + 4 gates + N buttons) and the
// separate monospace Live preview (dec-4) are gone: a circumstance's detail IS
// the composed prompt, base vs the team's additions inline. Authoring is
// in-context (dec-5); the two-agent parity split is legible (dec-6); the
// explainer is demoted and the timeline is the landing (dec-7).
//
// Data still loads via the api/scaffold client (base + Org merged) and admin
// edits refetch inline — the std-8 bus invalidates the server cache so the next
// GET reflects the change.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { parseTenantFromPathname } from '../utils/tenantUrl';
import {
  fetchScaffoldFor,
  createScaffoldAdditionFor,
  updateScaffoldAdditionFor,
  deleteScaffoldAdditionFor,
  toggleScaffoldAdditionFor,
  type ScaffoldFetchResponse,
  type ScaffoldOwnerRef,
  type OrgScaffoldAddition,
} from '../api/scaffold';
import { getOrgApi } from '../api/client';
import { ScaffoldExplainer } from '../components/scaffold/ScaffoldExplainer';
import { ScaffoldTimeline } from '../components/scaffold/ScaffoldTimeline';
import { ScaffoldPhaseDetail } from '../components/scaffold/ScaffoldPhaseDetail';
import { CircumstanceDetail } from '../components/scaffold/CircumstanceDetail';
import { ScaffoldProposalReview } from '../components/scaffold/ScaffoldProposalReview';
import { ChatPanel } from '../components/ChatPanel';
import { ResizableChatRail } from '../components/chat/ResizableChatRail';
import { useChat } from '../components/ChatContext';
import {
  buttonSegments,
  globalSegments,
  orgCountForButton,
  orgCountGlobal,
  rubricSegments,
} from '../components/scaffold/composition';
import {
  HANDOFF_BUTTON_BY_PHASE,
  BASE_SCAFFOLD,
  scaffoldReviewEditSeed,
  describeScaffoldTarget,
  type GuidanceBlock,
  type Phase,
  type Transition,
  type ScaffoldProposal,
} from '@memex/shared';

type Selection =
  | { kind: 'home' }
  | { kind: 'global' }
  | { kind: 'phase'; phase: Phase; tool: string | null }
  | { kind: 'gate'; transition: Transition }
  | { kind: 'button'; buttonId: string };

// spec-360: the SELECTED circumstance's control always wears a clear accent ring
// so you can see what the detail pane is showing (SELECT_RING). When the
// assistant has just navigated here, the ring brightens briefly (PULSE_RING) so
// the eye follows the agent's move. `ringFor(active, pulse)` picks the right one.
const SELECT_RING = 'ring-2 ring-accent/60 ring-offset-1 ring-offset-surface';
const PULSE_RING = 'ring-2 ring-accent ring-offset-1 ring-offset-surface';
function ringFor(active: boolean, pulse: boolean): string {
  if (!active) return '';
  return pulse ? PULSE_RING : SELECT_RING;
}

// spec-389 t-1 (dec-1): the drag-resizable chat rail is now the shared
// ResizableChatRail component (extracted from this surface). This page just
// passes its per-surface storage key.
const CHAT_WIDTH_KEY = 'scaffold-chat-width';

const PHASE_BEFORE_TRANSITION: Record<Transition, Phase> = {
  specify: 'draft',
  build: 'specify',
  verify: 'build',
  done: 'verify',
};

// The deterministic fact-sheet SHAPE shown alongside a gate rubric (values are
// computed per-Spec at runtime by spec-readiness.ts). Carried over from spec-68.
const FACT_SHEET_SHAPE: { name: string; explainer: string }[] = [
  { name: 'open decisions', explainer: 'decisions not yet resolved or rejected.' },
  { name: 'candidate decisions', explainer: 'pending agent-extracted candidates.' },
  { name: 'incomplete tasks', explainer: 'tasks not in a terminal status.' },
  { name: 'resolved-decision AC coverage', explainer: 'resolved decisions with no implementation ACs.' },
  { name: 'open drift comments', explainer: 'drift / plan_revision comments still open.' },
  { name: 'narrative staleness', explainer: 'time since narrative last edited vs resolved decisions.' },
];

export function ScaffoldInspect() {
  const { session, token } = useAuth();
  const location = useLocation();

  const tenant = parseTenantFromPathname(location.pathname);
  const currentMembership = tenant
    ? session?.memberships.find((m) => m.slug === tenant.namespace && m.memexSlug === tenant.memex)
    : session?.memberships.find((m) => m.memexId === session?.currentMemexId);
  // spec-360 follow-up: a personal namespace's OWNER is the admin of their own
  // workspace — so authoring is theirs by right. An org row keeps the existing
  // org-membership role.
  const isPersonal = currentMembership?.kind === 'personal';
  const isAdmin = isPersonal || currentMembership?.role === 'administrator';
  const currentMemexId = currentMembership?.memexId ?? null;
  const currentMemexLabel = tenant?.memex;

  // spec-360 follow-up: the scaffold owner — the ORG (admins author org-wide) or
  // the PERSONAL namespace (its owner authors on their own Memex). Drives which
  // API surface every read/write below targets. For personal we already have the
  // namespace + memex slugs from the path; for org we resolve the orgId.
  const [owner, setOwner] = useState<ScaffoldOwnerRef | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Personal namespace: own the scaffold via the tenant-prefixed path. No
      // org lookup — a personal namespace has no org.
      if (isPersonal && tenant) {
        if (!cancelled) {
          setOwner({ kind: 'personal', namespace: tenant.namespace, memex: tenant.memex });
        }
        return;
      }
      try {
        const org = await getOrgApi(token);
        if (cancelled) return;
        setOwner({ kind: 'org', orgId: org.id });
      } catch {
        if (cancelled) return;
        setOwner(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, isPersonal, tenant?.namespace, tenant?.memex]); // eslint-disable-line react-hooks/exhaustive-deps

  const baseFallback = useMemo<ScaffoldFetchResponse>(() => ({ base: BASE_SCAFFOLD, org: [] }), []);
  const [data, setData] = useState<ScaffoldFetchResponse>(baseFallback);

  const load = useCallback(async () => {
    if (!owner) return;
    try {
      const payload = await fetchScaffoldFor(owner);
      setData(payload);
    } catch {
      // Non-fatal: keep showing the base scaffold.
    }
  }, [owner]);

  useEffect(() => {
    if (owner) void load();
  }, [owner, load]);

  // Edit requires authoring capability AND a resolved owner. For an org that's
  // the admin role; for a personal namespace the owner always qualifies (isAdmin
  // is already true for personal). View is open to any member.
  const canEdit = !!isAdmin && !!owner;
  // A non-authoring viewer (org member who isn't an admin): show the explicit
  // "admin required" note — the read-only state is explained, not silently
  // missing controls. A personal owner is never in this state.
  const showAdminNote = !!owner && !isAdmin;

  const [selected, setSelected] = useState<Selection>({ kind: 'home' });

  // OrgScaffoldAddition (not the base GuidanceBlock) so the persisted `id` is
  // available — used to look a block up for the review seed below; assignable to
  // the GuidanceBlock[] the composition/timeline helpers expect.
  const orgBlocks = useMemo<readonly OrgScaffoldAddition[]>(() => data?.org ?? [], [data]);

  // spec-360 t-1 (dec-1/dec-6): the scaffold assistant rides this surface in
  // `scaffold` agent mode — entered on mount, left on unmount. It's open to any
  // active member for explanation; authoring proposals are admin-gated server-side.
  const {
    enterScaffoldMode,
    exitScaffoldMode,
    scaffoldProposal,
    clearScaffoldProposal,
    scaffoldNav,
    sendMessage,
  } = useChat();
  useEffect(() => {
    enterScaffoldMode();
    return () => exitScaffoldMode();
  }, [enterScaffoldMode, exitScaffoldMode]);
  // No opening LLM turn — the assistant introduces itself with a STATIC card in
  // ChatPanel (scaffold mode, empty thread), so loading the page costs nothing.

  const handleCreate = useCallback(
    async (input: {
      target: GuidanceBlock['target'];
      text: string;
      rationale: string;
      emphasis?: GuidanceBlock['emphasis'];
      memexId?: string;
    }) => {
      if (!owner) throw new Error('No scaffold owner resolved');
      await createScaffoldAdditionFor(owner, input);
      await load();
    },
    [owner, load],
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      if (!owner) throw new Error('No scaffold owner resolved');
      await toggleScaffoldAdditionFor(owner, id, enabled);
      await load();
    },
    [owner, load],
  );

  const handleUpdate = useCallback(
    async (id: string, text: string) => {
      if (!owner) throw new Error('No scaffold owner resolved');
      await updateScaffoldAdditionFor(owner, id, { text });
      await load();
    },
    [owner, load],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!owner) throw new Error('No scaffold owner resolved');
      await deleteScaffoldAdditionFor(owner, id);
      await load();
    },
    [owner, load],
  );

  // The scrollable detail pane — so a freshly-drafted proposal (which renders at
  // the TOP of this pane) can be scrolled into view even if the user was scrolled
  // down reading a circumstance.
  const detailRef = useRef<HTMLElement>(null);

  // spec-360 t-4 (dec-4): when the assistant drafts a proposal, navigate the
  // timeline to the target circumstance so the detail pane shows the TRUE current
  // composition next to the pending change. The review card renders the change
  // composed in place (ac-9). Also scroll the pane to the top so the proposal is
  // visible without the user hunting for it.
  useEffect(() => {
    if (!scaffoldProposal) return;
    const target = scaffoldProposal.target ?? scaffoldProposal.before?.target ?? {};
    if (target.tool && target.phase) {
      setSelected({ kind: 'phase', phase: target.phase, tool: target.tool });
    } else if (target.phase) {
      setSelected({ kind: 'phase', phase: target.phase, tool: null });
    } else if (target.transition) {
      setSelected({ kind: 'gate', transition: target.transition });
    } else if (target.button) {
      setSelected({ kind: 'button', buttonId: target.button });
    } else {
      setSelected({ kind: 'global' });
    }
    // `?.scrollTo?.` — jsdom (tests) doesn't implement Element.scrollTo.
    detailRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }, [scaffoldProposal]);

  // spec-360: the assistant navigated the surface (render_navigate).
  // Select that circumstance in the right pane — same target→Selection mapping as
  // the proposal effect — and PULSE the timeline control that leads there, so the
  // user sees where the assistant moved them (they didn't click it themselves).
  const [navPulse, setNavPulse] = useState(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!scaffoldNav) return;
    const t = scaffoldNav.target ?? {};
    if (t.tool && t.phase) {
      setSelected({ kind: 'phase', phase: t.phase, tool: t.tool });
    } else if (t.phase) {
      setSelected({ kind: 'phase', phase: t.phase, tool: null });
    } else if (t.transition) {
      setSelected({ kind: 'gate', transition: t.transition });
    } else if (t.button) {
      setSelected({ kind: 'button', buttonId: t.button });
    } else {
      setSelected({ kind: 'global' });
    }
    setNavPulse(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setNavPulse(false), 1600);
    return () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
    };
    // Keyed on `seq` so a repeat navigation to the same target re-pulses.
  }, [scaffoldNav]);

  // spec-360 t-4 (dec-2): approve = perform the write through the SAME admin-gated
  // route spec-343 uses (createScaffoldAddition / update / toggle / delete). Only
  // on approval does anything change; the bus invalidates the cache and `load()`
  // (called by each handler) refreshes the timeline in place (ac-2).
  const approveProposal = useCallback(
    async (p: ScaffoldProposal) => {
      switch (p.operation) {
        case 'add':
          await handleCreate({
            target: (p.target ?? {}) as GuidanceBlock['target'],
            text: p.text ?? '',
            rationale: p.rationale ?? '',
            ...(p.emphasis ? { emphasis: p.emphasis } : {}),
            // spec-360: 'memex' scope resolves to this Memex's id; 'org'
            // (or omitted) stays org-wide (memexId undefined).
            ...(p.scope === 'memex' && currentMemexId ? { memexId: currentMemexId } : {}),
          });
          break;
        case 'edit':
          if (p.blockId) await handleUpdate(p.blockId, p.text ?? '');
          break;
        case 'disable':
          if (p.blockId) await handleToggle(p.blockId, false);
          break;
        case 'enable':
          if (p.blockId) await handleToggle(p.blockId, true);
          break;
        case 'delete':
          if (p.blockId) await handleDelete(p.blockId);
          break;
      }
      clearScaffoldProposal();
    },
    [handleCreate, handleUpdate, handleToggle, handleDelete, clearScaffoldProposal, currentMemexId],
  );

  // spec-360: a MANUAL add/edit (inline authoring, not the assistant's propose
  // flow) is sent to the assistant for an assessment — is it possible + effective?
  // — so a weak or impossible rule doesn't land unreviewed. Only wraps the manual
  // UI callbacks; the agent's own proposal-approvals (approveProposal → handleCreate)
  // are NOT re-reviewed (the assistant already assessed before proposing).
  const handleCreateAndReview = useCallback(
    async (input: Parameters<typeof handleCreate>[0]) => {
      await handleCreate(input);
      sendMessage?.(
        scaffoldReviewEditSeed({
          operation: 'added',
          targetLabel: describeScaffoldTarget(input.target),
          text: input.text,
        }),
      );
    },
    [handleCreate, sendMessage],
  );
  const handleUpdateAndReview = useCallback(
    async (id: string, text: string) => {
      await handleUpdate(id, text);
      sendMessage?.(
        scaffoldReviewEditSeed({
          operation: 'edited',
          targetLabel: describeScaffoldTarget(orgBlocks.find((b) => b.id === id)?.target ?? {}),
          text,
        }),
      );
    },
    [handleUpdate, orgBlocks, sendMessage],
  );

  // Why editing is unavailable — surfaced as the disabled "Add here" tooltip so
  // the capability is visible to everyone, usable only by org admins (dec-2).
  const editDisabledReason = !owner
    ? 'Scaffold guidance is set per Memex — open a workspace to add or edit it.'
    : 'Only administrators can add or edit scaffold guidance.';

  const editProps = {
    isAdmin: canEdit,
    disabledReason: editDisabledReason,
    onCreate: canEdit ? handleCreateAndReview : undefined,
    onToggle: canEdit ? handleToggle : undefined,
    onUpdate: canEdit ? handleUpdateAndReview : undefined,
    onDelete: canEdit ? handleDelete : undefined,
    currentMemexId,
    currentMemexLabel,
  };

  // Handoff buttons get their OWN row (they're lifecycle/role handoffs, not
  // cross-phase actions): the three phase handoffs in lifecycle order, then the
  // review handoff. Resolved to real buttons; without a home here, selecting one
  // (e.g. via the assistant's navigation) left nothing highlighted.
  const handoffButtonIds = useMemo(
    () =>
      [
        HANDOFF_BUTTON_BY_PHASE.specify, // Specify handoff
        'review-handoff', // Review follows specify in the lifecycle
        HANDOFF_BUTTON_BY_PHASE.build,
        HANDOFF_BUTTON_BY_PHASE.verify,
      ].filter((id): id is string => !!id),
    [],
  );
  const handoffIds = useMemo(() => new Set(handoffButtonIds), [handoffButtonIds]);
  const handoffButtons = useMemo(
    () =>
      handoffButtonIds
        .map((id) => data.base.promptButtons.find((b) => b.id === id))
        .filter((b): b is NonNullable<typeof b> => !!b),
    [handoffButtonIds, data.base.promptButtons],
  );
  const actionButtons = useMemo(
    () => data.base.promptButtons.filter((b) => !handoffIds.has(b.id)),
    [data.base.promptButtons, handoffIds],
  );

  const selectedButton =
    selected.kind === 'button' ? data.base.promptButtons.find((b) => b.id === selected.buttonId) : undefined;

  return (
    <div className="flex h-full overflow-hidden" data-testid="scaffold-inspect-page">
      {/* spec-360 t-1 (dec-1/dec-6): the scaffold assistant — a left-rail panel,
          the established Standards/Drift agent position. Open to any member for
          explanation; authoring proposals are admin-gated server-side. */}
      <ResizableChatRail
        storageKey={CHAT_WIDTH_KEY}
        testId="scaffold-assistant-panel"
        handleTestId="scaffold-chat-resize"
        label="Scaffold"
      >
        <ChatPanel />
      </ResizableChatRail>

      {/* Inspect column: page heading + timeline + detail (+ any pending proposal). */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
      {/* Page heading — matches the other tenant pages (Drift Inbox etc.). */}
      <div className="shrink-0 border-b border-edge px-4 pt-4 pb-3">
        <h1 className="text-2xl font-semibold text-heading">Scaffold</h1>
        <p className="text-xs text-muted mt-1">
          The prompting every agent in this Memex reads — and your org’s additions to it.
        </p>
      </div>
      {/* Top frame: admin note, always-applies band, timeline, actions. The
          "how it works" explainer moved into the empty (home) detail state below. */}
      <div className="shrink-0 border-b border-edge p-4 space-y-3">
        {/* spec-360: dirty-state indicator — a pending proposal awaits approval.
            Clicking it scrolls the detail pane to the review card. */}
        {scaffoldProposal ? (
          <button
            type="button"
            data-testid="scaffold-pending-indicator"
            onClick={() => detailRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' })}
            className="flex w-full items-center gap-2 rounded-md border border-amber-500/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-600 transition-colors hover:bg-amber-400/20 dark:text-amber-400"
          >
            <span aria-hidden="true" className="text-amber-500">●</span>
            <span className="font-medium">A change to your org’s guidance is awaiting approval</span>
            <span className="ml-auto text-xs underline underline-offset-2">Review</span>
          </button>
        ) : null}

        {showAdminNote ? (
          <div
            data-testid="scaffold-admin-required-note"
            className="rounded-md border border-edge bg-muted/20 px-3 py-2 text-sm text-secondary"
          >
            Viewing only — an administrator can add or change this guidance.
          </div>
        ) : null}

        {/* Three labelled groups, aligned on a shared left gutter. */}
        <div className="space-y-2">
          <LabeledRow label="Always">
            <button
              type="button"
              data-testid="scaffold-always-applies-band"
              aria-current={selected.kind === 'global' ? 'true' : undefined}
              onClick={() => setSelected({ kind: 'global' })}
              className={`flex w-full items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                selected.kind === 'global'
                  ? 'border-edge bg-overlay text-primary'
                  : 'border-transparent text-secondary hover:text-primary hover:bg-overlay'
              } ${ringFor(selected.kind === 'global', navPulse)}`}
            >
              <span>Applies to every agent response — role + org-global guidance</span>
              {orgCountGlobal(orgBlocks) > 0 ? (
                <span className="ml-1 text-[10px] font-semibold text-amber-500">● {orgCountGlobal(orgBlocks)}</span>
              ) : null}
            </button>
          </LabeledRow>

          <LabeledRow label="Lifecycle">
            <ScaffoldTimeline
              selected={
                selected.kind === 'phase'
                  ? { kind: 'phase', phase: selected.phase }
                  : selected.kind === 'gate'
                    ? { kind: 'gate', transition: selected.transition }
                    : null
              }
              orgBlocks={orgBlocks}
              onSelectPhase={(phase) => setSelected({ kind: 'phase', phase, tool: null })}
              onSelectGate={(transition) => setSelected({ kind: 'gate', transition })}
              pulse={navPulse}
            />
          </LabeledRow>

          {actionButtons.length > 0 ? (
            <LabeledRow label="Actions">
              <div data-testid="scaffold-actions-shelf" className="flex flex-wrap items-center gap-1">
                {actionButtons.map((b) => {
                  const active = selected.kind === 'button' && selected.buttonId === b.id;
                  const count = orgCountForButton(orgBlocks, b.id);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      data-testid={`scaffold-action-button-${b.id}`}
                      aria-pressed={active}
                      onClick={() => setSelected({ kind: 'button', buttonId: b.id })}
                      className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                        active ? 'bg-overlay text-primary font-medium' : 'text-secondary hover:text-primary hover:bg-overlay'
                      } ${ringFor(active, navPulse)}`}
                    >
                      {b.label}
                      {count > 0 ? <span className="ml-1 text-[10px] font-semibold text-amber-500">●{count}</span> : null}
                    </button>
                  );
                })}
              </div>
            </LabeledRow>
          ) : null}

          {handoffButtons.length > 0 ? (
            <LabeledRow label="Handoffs">
              <div data-testid="scaffold-handoffs-shelf" className="flex flex-wrap items-center gap-1">
                {handoffButtons.map((b) => {
                  const active = selected.kind === 'button' && selected.buttonId === b.id;
                  const count = orgCountForButton(orgBlocks, b.id);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      data-testid={`scaffold-handoff-button-${b.id}`}
                      aria-pressed={active}
                      onClick={() => setSelected({ kind: 'button', buttonId: b.id })}
                      className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                        active ? 'bg-overlay text-primary font-medium' : 'text-secondary hover:text-primary hover:bg-overlay'
                      } ${ringFor(active, navPulse)}`}
                    >
                      {b.label}
                      {count > 0 ? <span className="ml-1 text-[10px] font-semibold text-amber-500">●{count}</span> : null}
                    </button>
                  );
                })}
              </div>
            </LabeledRow>
          ) : null}
        </div>
      </div>

      {/* Detail pane. */}
      <main ref={detailRef} className="flex-1 min-w-0 overflow-y-auto p-8">
        <div className="max-w-4xl space-y-6">
          {/* spec-360: a way back to the empty-state explainer once you've
              navigated into a circumstance. Hidden on home (you're already there). */}
          {selected.kind !== 'home' ? (
            <div className="flex justify-start">
              <button
                type="button"
                data-testid="scaffold-about-link"
                onClick={() => setSelected({ kind: 'home' })}
                className="inline-flex items-center gap-1.5 text-xs text-secondary transition-colors hover:text-primary"
              >
                <span aria-hidden="true">←</span> About
              </button>
            </div>
          ) : null}

          {/* spec-360 t-4 (dec-4): a pending propose-then-confirm change renders
              here, composed in place, navigated-to on the timeline above. */}
          {scaffoldProposal ? (
            <ScaffoldProposalReview
              proposal={scaffoldProposal}
              onApprove={approveProposal}
              onReject={clearScaffoldProposal}
            />
          ) : null}

          {selected.kind === 'home' ? (
            <div data-testid="scaffold-home-hint" className="space-y-5">
              <p className="text-sm text-secondary">
                Pick a moment above — a phase, a gate, the always-applies band, or an action — to see exactly what the
                agent reads then, and add your own guidance.
              </p>
              {/* spec-360: the "how it works" explainer is the empty-state content
                  here (it used to be a collapsible strip at the top). The badge
                  reflects effective authoring capability (admin AND an org). */}
              <ScaffoldExplainer isAdmin={canEdit} />
            </div>
          ) : null}

          {selected.kind === 'global' ? (
            <CircumstanceDetail
              testId="scaffold-circumstance-global"
              title="Always applies"
              subtitle="Org-global guidance — rides every agent response, in every phase. Broad by design; use sparingly."
              segments={globalSegments(data.base, orgBlocks)}
              addTarget={{}}
              reach="both"
              emptyHint="No org-global guidance — most guidance should attach to a specific moment instead."
              {...editProps}
            />
          ) : null}

          {selected.kind === 'phase' ? (
            <ScaffoldPhaseDetail
              phase={selected.phase}
              dataset={data.base}
              orgBlocks={orgBlocks}
              selectedTool={selected.tool}
              onSelectTool={(tool) =>
                setSelected((s) => (s.kind === 'phase' ? { ...s, tool } : s))
              }
              onSelectGate={(transition) => setSelected({ kind: 'gate', transition })}
              onSelectButton={(buttonId) => setSelected({ kind: 'button', buttonId })}
              {...editProps}
            />
          ) : null}

          {selected.kind === 'gate' ? (
            <div className="space-y-8">
              <CircumstanceDetail
                testId="scaffold-circumstance-gate"
                title={`Gate: ${PHASE_BEFORE_TRANSITION[selected.transition]} → ${selected.transition}`}
                subtitle="The composed rubric the agent walks at this forward transition."
                segments={rubricSegments(data.base, selected.transition, orgBlocks)}
                addTarget={{ transition: selected.transition }}
                reach="both"
                emptyHint="No base rubric defined for this gate."
                {...editProps}
              />
              <section data-testid="scaffold-gate-fact-sheet">
                <h3 className="text-sm font-semibold text-heading mb-2">Deterministic fact-sheet shape</h3>
                <p className="text-xs text-secondary mb-2">
                  The agent also receives these facts (computed per-Spec at runtime) alongside the rubric.
                </p>
                <ul className="text-xs space-y-1 list-disc list-inside text-secondary">
                  {FACT_SHEET_SHAPE.map((f) => (
                    <li key={f.name}>
                      <span className="font-semibold">{f.name}</span> — {f.explainer}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          ) : null}

          {selected.kind === 'button' && selectedButton ? (
            <CircumstanceDetail
              testId="scaffold-circumstance-button"
              title={`Prompt button: ${selectedButton.label}`}
              subtitle={selectedButton.rationale}
              segments={buttonSegments(data.base, selectedButton.id, orgBlocks)}
              addTarget={{ button: selectedButton.id }}
              buttonLabel={selectedButton.label}
              emptyHint="No base prompt for this button."
              {...editProps}
            />
          ) : null}
        </div>
      </main>
      </div>
    </div>
  );
}

/** A top-frame group: a fixed-width uppercase label in the left gutter beside
 *  its content, so Always / Lifecycle / Actions read as aligned headings. */
function LabeledRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-16 shrink-0 pt-1.5 text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
