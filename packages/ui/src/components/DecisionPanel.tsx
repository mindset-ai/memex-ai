import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeRefLinkifier } from './chat/refLinkifier';
import { phaseDisplayName } from '../utils/phaseDisplay';
import type { Decision, Comment } from '../api/types';
import {
  resolveDecisionApi,
  createDecisionComment,
  fetchAcsForBrief,
  type AcWithVerification,
} from '../api/client';
import { BASE_SCAFFOLD, toButtonPrompt, type GuidanceBlock } from '@memex/shared';
import { useAuth } from './AuthContext';
import { useChat } from './ChatContext';
import { CommentTray } from './CommentTray';
import { Badge, Button, Tabs } from './ui';
import { DecisionAcStrip } from './DecisionAcStrip';
import { PromptButton } from './PromptButton';
import { TextArea } from './ui/TextArea';

interface DecisionPanelProps {
  docId: string;
  decisions: Decision[];
  commentsByDecision?: Record<string, Comment[]>;
  forceShowComments?: boolean;
  onCommentsChange?: (targetId: string, comments: Comment[]) => void;
  onUpdate: () => void;
  /** When set (e.g. ?decision=dec-7 in the URL), the panel switches to the right
   *  tab for that decision's status, scrolls its row into view, and applies a
   *  short highlight ring (t-19 W3). */
  highlightDecisionHandle?: string | null;
  /** Forwarded to DecisionAcStrip: when a pill is clicked, the parent
   *  (DocDocument) switches to the AC tab and focuses the target AC. */
  onJumpToAc?: (acId: string) => void;
  /**
   * spec-111 t-8: when false (non-member reading a public Memex), every
   * mutation control is suppressed — the option picker on open decisions and
   * the comment composer in each tray. The decision content stays fully
   * readable. Defaults to true so member call sites are unchanged.
   */
  canWrite?: boolean;
  /**
   * spec-118 t-6: when false (a reviewer — write access to the Memex but a
   * reviewer posture on this Spec), the forward-driving controls are
   * suppressed (the answering option picker, re-select, Add reasoning) while
   * the comment composer in each tray — gated on `canWrite`, not `canEdit` —
   * stays available so reviewers can still comment and @mention. Defaults to
   * true so existing editor call sites are unchanged.
   */
  canEdit?: boolean;
  /**
   * spec-164 dec-3: the Spec's current phase. While the Spec is still in
   * `draft` AND no decisions exist, the panel gates the *invitation* — an
   * empty-state directive pointing at the move to Specify — instead of empty
   * list scaffolding. Decisions that already exist always render (agents may
   * legitimately create them in draft, spec-12 dec-1).
   */
  specPhase?: string;
  /**
   * spec-178 ac-24: when true (a frozen Handhold demo spec) the decision context /
   * resolution markdown does NOT run rehypeRefLinkifier — handle refs render as plain
   * text instead of navigable `<a>` links, mirroring SectionCard. The demo replicates
   * spec-64; its refs belong to the original spec's world, not the user's, so linking
   * them would dead-end. Defaults to false (real specs keep auto-linking).
   */
  isDemo?: boolean;
  /**
   * spec-247 dec-4: interpolation context ({namespace}/{memex}/{handle}/…) for
   * the boundary-handoff PromptButtons (candidate review) and the chat-seeded
   * "Ask for more explanation" prompt. Absent (e.g. in isolated tests) the
   * marker lines are omitted and the explain affordance falls back to the
   * decision handle alone.
   */
  promptContext?: Record<string, unknown>;
  /** Org scaffold appends threaded into toButtonPrompt (spec-159 ac-17). */
  orgBlocks?: readonly GuidanceBlock[];
}

type TabId = 'candidates' | 'open' | 'resolved';

export function DecisionPanel({ docId, decisions, commentsByDecision = {}, forceShowComments: _forceShowComments, onCommentsChange, onUpdate, highlightDecisionHandle, onJumpToAc, canWrite = true, canEdit = true, specPhase, isDemo = false, promptContext, orgBlocks }: DecisionPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // spec-178 ac-24: suppress handle auto-linking inside a frozen demo spec's
  // decision prose. Mirrors SectionCard's rehypePlugins switch.
  const decisionRehypePlugins = isDemo ? [] : [rehypeRefLinkifier];
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const chat = useChat();
  const { user } = useAuth();
  const authorName = user?.name ?? 'Anonymous';

  const [showCommentsFor, setShowCommentsFor] = useState<string | null>(null);
  const [collapsedOpen, setCollapsedOpen] = useState<Set<string>>(new Set());

  // Per-candidate UI state. spec-247 dec-6: candidates are VIEW-ONLY on the
  // web — no option radios, no Approve/Reject. The only candidate-side write
  // left is "Flag for discussion" (a question-typed comment, not part of the
  // approval process — approving/rejecting happens from the coding agent).
  const [flagBodyByCandidate, setFlagBodyByCandidate] = useState<Record<string, string>>({});
  const [showFlagFor, setShowFlagFor] = useState<string | null>(null);
  const [busyCandidate, setBusyCandidate] = useState<string | null>(null);

  // spec-247 dec-1/dec-5 (persist-on-select): clicking an option on an open
  // decision IS the resolution — the click immediately calls the resolve API
  // with that chosenOptionIndex (resolution prose defaults server-side to the
  // option's label). `chosenByOpen` only carries the optimistic checked state
  // while the call is in flight; the persisted truth arrives via onUpdate().
  const [chosenByOpen, setChosenByOpen] = useState<Record<string, number>>({});
  const [busyOpen, setBusyOpen] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<Record<string, string>>({});

  // spec-247 dec-2: discussion comments live behind a per-card toggle on the
  // answering path — never inline next to the picker.
  const [discussionFor, setDiscussionFor] = useState<Set<string>>(new Set());

  // spec-247 dec-5: optional, editable-after rationale on resolved decisions
  // ("Add reasoning"), plus re-select busy state.
  const [reasoningFor, setReasoningFor] = useState<string | null>(null);
  const [reasoningDraft, setReasoningDraft] = useState<Record<string, string>>({});
  const [busyResolved, setBusyResolved] = useState<string | null>(null);
  // Optimistic checked state for re-select, mirroring chosenByOpen — the radio
  // flips on click, not after the refetch round-trip.
  const [reselectByResolved, setReselectByResolved] = useState<Record<string, number>>({});

  // ACs for the Spec — polled every 3s while the tab is visible so a new
  // test_event lands in the strip within ~3s without requiring tab nav.
  // Same Page Visibility-aware pattern as AcPanel so a backgrounded tab
  // doesn't burn cycles. SSE upgrade is the future path; for phase 1 this
  // keeps the "watch a test go green" loop tight.
  //
  // Errors are swallowed silently — the strip is a non-critical decoration
  // on the Decisions tab, and a polling blip shouldn't pollute the console.
  // Also re-runs when `decisions` changes (resolving a Decision spawns
  // Implementation ACs; the dep array makes that immediate, not 3s later).
  const [acs, setAcs] = useState<AcWithVerification[]>([]);
  const acFetchInFlight = useRef(false);
  useEffect(() => {
    const POLL_MS = 3_000;
    let cancelled = false;
    const load = async () => {
      if (acFetchInFlight.current) return;
      acFetchInFlight.current = true;
      try {
        const rows = await fetchAcsForBrief(docId);
        if (!cancelled) setAcs(rows);
      } catch {
        // silent
      } finally {
        acFetchInFlight.current = false;
      }
    };
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        void load();
      }, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisChange = () => {
      if (document.visibilityState === 'visible') {
        void load();
        start();
      } else {
        stop();
      }
    };
    void load();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [docId, decisions]);

  const candidates = useMemo(
    () => decisions.filter((d) => d.status === 'candidate'),
    [decisions],
  );
  const open = useMemo(
    () => decisions.filter((d) => d.status === 'open'),
    [decisions],
  );
  const resolved = useMemo(
    () => decisions.filter((d) => d.status === 'resolved'),
    [decisions],
  );

  // Default the visible tab to Candidates when any exist (per t-16 AC), else
  // Open. We re-evaluate on each render only via the initial state — once the
  // user clicks a tab their selection wins.
  const [activeTab, setActiveTab] = useState<TabId>(
    candidates.length > 0 ? 'candidates' : 'open',
  );

  // ?decision=D-N (or legacy `dec-N` from standard content) — switch to the right
  // tab for the matching decision's status, then scroll its card into view and
  // pulse a highlight ring for ~2s. (t-19 W3.1; case-insensitive after doc-26
  // rename so legacy `[per dec-N]` standard cites still deep-link.)
  // Re-runs whenever the deep-link handle or the decisions array changes (e.g. SSE
  // refetch updates the list). The highlight clears itself; if the user's already
  // looking at the row, the short ring is the only visual change.
  useEffect(() => {
    if (!highlightDecisionHandle) return;
    const m = highlightDecisionHandle.match(/^(?:D|dec)-(\d+)$/i);
    if (!m) return;
    const seq = Number(m[1]);
    const target = decisions.find((d) => d.seq === seq);
    if (!target) return;

    if (target.status === 'candidate') setActiveTab('candidates');
    else if (target.status === 'open') setActiveTab('open');
    else if (target.status === 'resolved') setActiveTab('resolved');

    // Defer to next tick so the tab change has rendered the matching card.
    const handle = window.setTimeout(() => {
      const card = panelRef.current?.querySelector<HTMLElement>(
        `[data-decision-seq="D-${seq}"]`,
      );
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setHighlightedId(target.id);
      window.setTimeout(() => setHighlightedId(null), 2000);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [highlightDecisionHandle, decisions]);

  const handleFlag = async (decId: string) => {
    const content = (flagBodyByCandidate[decId] ?? '').trim();
    if (!content) return;
    setBusyCandidate(decId);
    try {
      // Per t-9 / dec-22 / Section 3: "Flag for discussion" creates a typed
      // comment of type='question' on the candidate. Source is server-stamped
      // ('human' for REST), so the client never supplies it.
      await createDecisionComment(decId, authorName, content, { type: 'question' });
      setFlagBodyByCandidate((prev) => {
        const next = { ...prev };
        delete next[decId];
        return next;
      });
      setShowFlagFor(null);
      onUpdate();
    } finally {
      setBusyCandidate(null);
    }
  };

  // spec-247 dec-1/dec-5 — the option row is the only answering affordance:
  // clicking persists immediately (no Save, no required prose, re-selectable).
  const handleSelectOption = async (dec: Decision, idx: number) => {
    if (!canEdit || busyOpen === dec.id) return;
    setChosenByOpen((prev) => ({ ...prev, [dec.id]: idx }));
    setSelectError((prev) => {
      const next = { ...prev };
      delete next[dec.id];
      return next;
    });
    setBusyOpen(dec.id);
    try {
      await resolveDecisionApi(dec.id, undefined, idx);
      onUpdate();
    } catch (err) {
      // Roll the optimistic pick back and surface the failure on the card —
      // a silent failure here would be the very silent-drop this Spec kills.
      setChosenByOpen((prev) => {
        const next = { ...prev };
        delete next[dec.id];
        return next;
      });
      setSelectError((prev) => ({
        ...prev,
        [dec.id]: err instanceof Error ? err.message : 'Failed to record the answer',
      }));
    } finally {
      setBusyOpen(null);
    }
  };

  // spec-247 dec-5 — re-select on an already-resolved decision updates the
  // choice in place (the server allows re-resolve).
  const handleReselect = async (dec: Decision, idx: number) => {
    if (!canEdit || busyResolved === dec.id || dec.chosenOptionIndex === idx) return;
    setReselectByResolved((prev) => ({ ...prev, [dec.id]: idx }));
    setBusyResolved(dec.id);
    try {
      await resolveDecisionApi(dec.id, undefined, idx);
      onUpdate();
    } catch (err) {
      console.error('Failed to re-select option:', err);
      setReselectByResolved((prev) => {
        const next = { ...prev };
        delete next[dec.id];
        return next;
      });
    } finally {
      setBusyResolved(null);
    }
  };

  // spec-247 dec-5 — optional rationale, editable after the fact. Saving rides
  // the same resolve path (re-resolve with prose + the current option index).
  const handleSaveReasoning = async (dec: Decision) => {
    const text = (reasoningDraft[dec.id] ?? '').trim();
    if (!text) return;
    setBusyResolved(dec.id);
    try {
      await resolveDecisionApi(dec.id, text, dec.chosenOptionIndex ?? undefined);
      setReasoningFor(null);
      setReasoningDraft((prev) => {
        const next = { ...prev };
        delete next[dec.id];
        return next;
      });
      onUpdate();
    } catch (err) {
      console.error('Failed to save reasoning:', err);
    } finally {
      setBusyResolved(null);
    }
  };

  // spec-247 dec-2 — "Ask for more explanation": routes to the spec assistant
  // with the decision pre-scoped (context chip) and seeds the Scaffold's
  // explanation prompt (std-15: prose lives in scaffold-data, not here).
  // Explanation only — the prompt forbids resolving.
  const handleExplain = (dec: Decision) => {
    chat.addContextChip({
      type: 'decision',
      id: dec.id,
      label: `Decision D-${dec.seq}`,
    });
    const prompt = toButtonPrompt({
      dataset: BASE_SCAFFOLD,
      buttonId: 'decision-explain',
      context: { ...(promptContext ?? {}), decision: `D-${dec.seq}` },
      orgBlocks,
    });
    if (prompt === null) {
      const message = 'DecisionPanel: no PromptButtonNode found for buttonId="decision-explain"';
      if (import.meta.env.DEV) throw new Error(message);
      // eslint-disable-next-line no-console
      console.error(message);
      return;
    }
    chat.sendMessage(prompt);
  };

  const toggleDiscussion = (decId: string) =>
    setDiscussionFor((prev) => {
      const next = new Set(prev);
      if (next.has(decId)) next.delete(decId);
      else next.add(decId);
      return next;
    });

  const openCommentCount = (decId: string) =>
    commentsByDecision[decId]?.filter((c) => !c.resolvedAt).length ?? 0;

  const allCommentCount = (decId: string) => commentsByDecision[decId]?.length ?? 0;

  // spec-247 dec-2 — the Discussion toggle + tray. The label states the one
  // thing the old inline box never said: comments never resolve a decision.
  const discussionBlock = (dec: Decision) => (
    <div className="mt-2 pt-2 border-t border-edge">
      <button
        type="button"
        data-testid="decision-discussion-toggle"
        onClick={() => toggleDiscussion(dec.id)}
        className="text-xs text-muted hover:text-secondary transition-colors"
      >
        {discussionFor.has(dec.id) ? 'Hide discussion' : `Discussion (${allCommentCount(dec.id)})`}
      </button>
      {discussionFor.has(dec.id) && (
        <div className="mt-2">
          <p data-testid="discussion-disclaimer" className="text-[11px] text-muted mb-2">
            Discussion only — comments never resolve a decision.
          </p>
          <CommentTray
            targetType="decision"
            targetId={dec.id}
            comments={commentsByDecision[dec.id] ?? []}
            onCommentsChange={onCommentsChange}
            canWrite={canWrite}
          />
        </div>
      )}
    </div>
  );

  const tabs: Array<{ id: TabId; label: string; count: number; countVariant?: 'default' | 'warning' | 'danger' }> = [
    { id: 'candidates', label: 'Candidates', count: candidates.length, countVariant: 'warning' },
    { id: 'open', label: 'Open', count: open.length, countVariant: 'warning' },
    { id: 'resolved', label: 'Resolved', count: resolved.length },
  ];

  // spec-164 dec-3: gate the invitation, never the content — a draft Spec
  // with zero decisions invites the move to Specify instead of presenting
  // empty tabs. Any existing decisions fall through to the normal render.
  if (specPhase === 'draft' && decisions.length === 0) {
    return (
      <div
        ref={panelRef}
        data-testid="decision-panel"
        className="border rounded-lg p-5 border-edge bg-panel"
      >
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-heading uppercase tracking-wider">
            Decisions
          </h3>
          <span className="text-xs text-muted">0 decisions</span>
        </div>
        <p data-testid="decision-draft-directive" className="text-sm text-muted">
          Move this spec to {phaseDisplayName('specify')} to start capturing
          Decisions and ACs.
        </p>
      </div>
    );
  }

  return (
    <div ref={panelRef} data-testid="decision-panel" className="border rounded-lg p-5 border-edge bg-panel">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-heading uppercase tracking-wider">
          Decisions
        </h3>
        <span className="text-xs text-muted">
          {candidates.length} candidate{candidates.length === 1 ? '' : 's'}, {open.length} open, {resolved.length} resolved
        </span>
      </div>

      <Tabs tabs={tabs} activeTab={activeTab} onChange={(id) => setActiveTab(id as TabId)} />

      {/* ── Candidates tab ─────────────────────────────────────── */}
      {activeTab === 'candidates' && (
        <div className="space-y-2 mb-4">
          {candidates.length === 0 && (
            <div className="text-sm text-muted space-y-1">
              <p>No candidate decisions yet.</p>
              <p className="text-xs">Decisions surface here automatically. While you discuss the spec in chat, the agent watches for choices with multiple options and trade-offs and proposes them as candidates for you to review.</p>
            </div>
          )}

          {/* spec-247 dec-6 / ac-21 — the boundary marker: candidate review
              (approve / reject) is coding-agent work, and the surface says so
              instead of offering web buttons that half-implement it. */}
          {candidates.length > 0 && promptContext && (
            <div data-testid="candidate-mcp-marker" className="rounded-md border border-edge-subtle bg-overlay/30 px-3 py-2">
              <PromptButton
                buttonId="review-candidates"
                context={promptContext}
                orgBlocks={orgBlocks}
                linkText="Review the candidate decisions"
                sentence="— copy this prompt into your coding agent. Approving or rejecting candidates happens there, not in the browser."
                sentenceLabel="Review the candidate decisions — copy this prompt into your coding agent. Approving or rejecting candidates happens there, not in the browser."
              />
            </div>
          )}

          {candidates.map((dec) => {
            const isBusy = busyCandidate === dec.id;
            return (
              <div
                key={dec.id}
                data-testid="decision-card"
                data-decision-seq={`D-${dec.seq}`}
                data-decision-status="candidate"
                data-highlighted={highlightedId === dec.id ? 'true' : undefined}
                className={`rounded-md border border-edge-subtle border-l-2 border-l-status-warning-border bg-surface/50 px-3 py-2.5 transition-shadow ${
                  highlightedId === dec.id ? 'ring-2 ring-accent ring-offset-1' : ''
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="flex-1 text-base font-semibold text-primary min-w-0">{dec.title}</span>
                  <Badge status="open" label="candidate" className="flex-none" />
                  <span className="flex-none text-xs font-mono text-muted">D-{dec.seq}</span>
                </div>

                {dec.context && (
                  <div className="mt-2 pl-2 border-l-2 border-edge-subtle">
                    <span className="text-[10px] uppercase tracking-wider text-muted font-medium">Context</span>
                    <div className="prose-dark prose-sm mt-0.5 opacity-80 [&>*]:my-1 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={decisionRehypePlugins}>{dec.context}</ReactMarkdown>
                    </div>
                  </div>
                )}

                {/* spec-247 dec-6 — options render as INFORMATION on a
                    candidate. No radios: nothing selectable means nothing can
                    be silently dropped (the spec-93 Failure 1 bug class). */}
                {dec.options && dec.options.length > 0 && (
                  <div className="mt-3 space-y-1.5" data-testid="candidate-options">
                    <div className="text-[10px] uppercase tracking-wider text-muted font-medium">Options</div>
                    {dec.options.map((opt, idx) => (
                      <div
                        key={idx}
                        data-testid={`candidate-option-${idx}`}
                        className="rounded-md border border-edge-subtle px-2 py-1.5"
                      >
                        <div className="text-sm font-medium text-primary">{opt.label}</div>
                        {opt.trade_offs && (
                          <div className="text-xs text-muted mt-0.5 whitespace-pre-wrap">{opt.trade_offs}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* spec-247 dec-6: no Approve / Reject on the web — the
                    approval process is MCP-only. The one remaining card
                    action is Flag for discussion (a question comment). */}
                {canEdit && (
                <div className="mt-3 pt-2 border-t border-edge flex flex-wrap gap-2 justify-end">
                  <Button
                    data-testid="candidate-flag"
                    onClick={() => {
                      setShowFlagFor(showFlagFor === dec.id ? null : dec.id);
                    }}
                    variant="ghost"
                    size="sm"
                    disabled={isBusy}
                  >
                    Flag for discussion
                  </Button>
                </div>
                )}

                {canEdit && showFlagFor === dec.id && (
                  <div className="mt-2 pt-2 border-t border-edge space-y-2">
                    <TextArea
                      data-testid="candidate-flag-body"
                      value={flagBodyByCandidate[dec.id] ?? ''}
                      onChange={(e) =>
                        setFlagBodyByCandidate((prev) => ({
                          ...prev,
                          [dec.id]: e.target.value,
                        }))
                      }
                      placeholder="What needs more discussion?"
                      rows={2}
                      textAreaSize="compact"
                    />
                    <div className="flex gap-2 justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowFlagFor(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        data-testid="candidate-flag-confirm"
                        type="button"
                        size="sm"
                        disabled={isBusy || !(flagBodyByCandidate[dec.id] ?? '').trim()}
                        onClick={() => handleFlag(dec.id)}
                      >
                        Post question
                      </Button>
                    </div>
                  </div>
                )}

                {discussionBlock(dec)}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Open tab ───────────────────────────────────────────── */}
      {activeTab === 'open' && (
        <div className="space-y-2 mb-4">
          {open.length === 0 && (
            <div className="text-sm text-muted space-y-1">
              <p>No open decisions.</p>
              <p className="text-xs">Decisions move here once a candidate is confirmed from your coding agent. An open decision is an unresolved choice with options on the table — picking an option records your answer.</p>
            </div>
          )}

          {open.map((dec) => {
            const isExpanded = !collapsedOpen.has(dec.id);
            const isBusy = busyOpen === dec.id;
            const chosenIdx = chosenByOpen[dec.id];
            const hasOptions = dec.options !== null && dec.options.length > 0;
            return (
              <div
                key={dec.id}
                data-testid="decision-card"
                data-decision-seq={`D-${dec.seq}`}
                data-decision-status="open"
                data-highlighted={highlightedId === dec.id ? 'true' : undefined}
                className={`group/dec rounded-md border border-edge-subtle border-l-2 border-l-status-warning-border bg-surface/50 px-3 py-2.5 transition-shadow ${
                  highlightedId === dec.id ? 'ring-2 ring-accent ring-offset-1' : ''
                }`}
              >
                <div
                  className="flex items-start gap-2 cursor-pointer"
                  onClick={() =>
                    setCollapsedOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(dec.id)) next.delete(dec.id);
                      else next.add(dec.id);
                      return next;
                    })
                  }
                >
                  <svg className={`w-3.5 h-3.5 flex-none mt-0.5 text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                  <span className="flex-1 text-base font-semibold text-primary min-w-0">{dec.title}</span>
                  <Badge status="open" className="flex-none" />
                  <span className="flex-none text-xs font-mono text-muted">D-{dec.seq}</span>
                </div>

                {isExpanded && (
                  <>
                    {dec.context && (
                      <div className="mt-2 pl-2 border-l-2 border-edge-subtle">
                        <span className="text-[10px] uppercase tracking-wider text-muted font-medium">Context</span>
                        <div className="prose-dark prose-sm mt-0.5 opacity-80 [&>*]:my-1 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={decisionRehypePlugins}>{dec.context}</ReactMarkdown>
                        </div>
                      </div>
                    )}

                    {/* spec-247 dec-1/dec-5 — the option rows ARE the
                        answering affordance. Clicking one records the answer
                        immediately; there is no Resolve button, and the hint
                        names the actual effect (ac-2: every control labelled
                        by what it does). */}
                    {hasOptions && (
                      <fieldset
                        className="mt-3 space-y-1.5"
                        data-testid="open-options"
                        disabled={!canEdit || isBusy}
                      >
                        <legend className="text-[10px] uppercase tracking-wider text-muted font-medium">Options</legend>
                        {dec.options!.map((opt, idx) => (
                          <label
                            key={idx}
                            className={`flex gap-2 items-start rounded-md border px-2 py-1.5 transition-colors ${
                              chosenIdx === idx
                                ? 'border-edge-strong bg-overlay'
                                : 'border-edge-subtle hover:bg-card-hover'
                            } ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
                          >
                            <input
                              type="radio"
                              name={`open-${dec.id}`}
                              value={idx}
                              checked={chosenIdx === idx}
                              disabled={!canEdit || isBusy}
                              onChange={() => void handleSelectOption(dec, idx)}
                              data-testid={`open-option-${idx}`}
                              className="mt-1"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-primary">{opt.label}</div>
                              {opt.trade_offs && (
                                <div className="text-xs text-muted mt-0.5 whitespace-pre-wrap">{opt.trade_offs}</div>
                              )}
                            </div>
                          </label>
                        ))}
                        {canEdit && (
                          <p data-testid="persist-on-select-hint" className="text-[11px] text-muted">
                            {isBusy
                              ? 'Recording your answer…'
                              : 'Picking an option records your answer — you can change it later.'}
                          </p>
                        )}
                      </fieldset>
                    )}

                    {selectError[dec.id] && (
                      <p data-testid="select-error" className="mt-1 text-xs text-status-danger-text">
                        {selectError[dec.id]}
                      </p>
                    )}

                    {/* spec-247 dec-1 — optionless decisions have NO resolve
                        control on the web: answering happens in conversation
                        with the spec assistant or from the coding agent. */}
                    {!hasOptions && (
                      <p data-testid="optionless-hint" className="mt-3 text-xs text-muted">
                        This decision has no structured options. Answer it in
                        conversation with the Spec assistant, or resolve it from
                        your coding agent.
                      </p>
                    )}

                    {/* spec-247 dec-2 — the explanation route: pre-scopes the
                        spec assistant to this decision and asks it to explain
                        the choice. It never resolves. */}
                    <div className="mt-2 flex justify-end">
                      <Button
                        data-testid="decision-explain"
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExplain(dec)}
                      >
                        Ask for more explanation
                      </Button>
                    </div>

                    {discussionBlock(dec)}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Resolved tab ───────────────────────────────────────── */}
      {activeTab === 'resolved' && (
        <div className="space-y-2 mb-4">
          {resolved.length === 0 && (
            <div className="text-sm text-muted space-y-1">
              <p>No resolved decisions yet.</p>
              <p className="text-xs">Resolved decisions land here once an open decision has been answered by picking an option (or in conversation). They become the durable "this is how we decided" record for the spec.</p>
            </div>
          )}

          {resolved.map((dec) => {
            const decOpenComments = openCommentCount(dec.id) > 0;
            const isBusy = busyResolved === dec.id;
            const shownChosenIdx = reselectByResolved[dec.id] ?? dec.chosenOptionIndex;
            return (
              <div
                key={dec.id}
                data-testid="decision-card"
                data-decision-seq={`D-${dec.seq}`}
                data-decision-status="resolved"
                data-highlighted={highlightedId === dec.id ? 'true' : undefined}
                onClick={() =>
                  chat.addContextChip({
                    type: 'decision',
                    id: dec.id,
                    label: `Decision D-${dec.seq}`,
                  })
                }
                className={`group/dec rounded-md border border-edge-subtle bg-surface/50 hover:bg-card-hover cursor-pointer transition-colors px-3 py-2 ${
                  highlightedId === dec.id ? 'ring-2 ring-accent ring-offset-1' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 flex-none text-status-success-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="flex-1 text-sm text-primary truncate min-w-0">
                    {dec.resolution || dec.title}
                  </span>
                  <Badge status="resolved" className="flex-none" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      chat.addContextChip({
                        type: 'decision',
                        id: dec.id,
                        label: `Decision D-${dec.seq}`,
                      });
                    }}
                    className="flex-none opacity-0 group-hover/dec:opacity-100 transition-opacity p-0.5 rounded hover:bg-card-hover"
                    title="Focus chat on this decision"
                  >
                    <svg className="w-3 h-3 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowCommentsFor(showCommentsFor === dec.id ? null : dec.id);
                    }}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium transition-colors border
                      ${decOpenComments || showCommentsFor === dec.id
                        ? 'bg-overlay text-primary border-edge-strong'
                        : 'opacity-0 group-hover/dec:opacity-100 bg-surface/50 text-muted border-edge hover:bg-overlay'
                      }`}
                    title={decOpenComments || showCommentsFor === dec.id ? 'Hide comments' : 'Show comments'}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                    </svg>
                    {openCommentCount(dec.id) > 0 ? openCommentCount(dec.id) : '+'}
                  </button>
                  <span className="flex-none text-xs font-mono text-muted">dec-{dec.seq}</span>
                </div>

                {dec.options && shownChosenIdx !== null && dec.options[shownChosenIdx] && (
                  <div className="mt-1 pl-6 text-xs text-muted">
                    <span className="font-medium text-status-success-text">Chose:</span>{' '}
                    {dec.options[shownChosenIdx].label}
                  </div>
                )}

                {(dec.context || dec.resolution || (dec.options && dec.options.length > 0)) && (
                  <details className="mt-2 pl-2 border-l-2 border-edge-subtle" onClick={(e) => e.stopPropagation()}>
                    <summary className="text-[10px] uppercase tracking-wider text-muted font-medium cursor-pointer select-none hover:text-secondary">Context</summary>
                    <div className="mt-1 space-y-2">
                      {dec.title !== dec.resolution && (
                        <div className="text-xs text-muted">
                          <span className="font-medium">Question:</span> {dec.title}
                        </div>
                      )}
                      {dec.resolution && (
                        <div className="pl-2 border-l-2 border-status-success-border/50">
                          <span className="text-[10px] uppercase tracking-wider text-status-success-text font-medium">Decision</span>
                          <div className="prose-dark prose-sm mt-0.5 [&>*]:my-1 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={decisionRehypePlugins}>{dec.resolution}</ReactMarkdown>
                          </div>
                        </div>
                      )}

                      {/* spec-247 dec-5 — re-select: the options stay live on a
                          resolved decision; clicking a different one updates
                          the recorded choice in place. */}
                      {dec.options && dec.options.length > 0 && (
                        <fieldset
                          className="space-y-1.5"
                          data-testid="resolved-options"
                          disabled={!canEdit || isBusy}
                        >
                          <legend className="text-[10px] uppercase tracking-wider text-muted font-medium">
                            Options{canEdit ? ' — pick another to change the answer' : ''}
                          </legend>
                          {dec.options.map((opt, idx) => (
                            <label
                              key={idx}
                              className={`flex gap-2 items-start rounded-md border px-2 py-1.5 transition-colors ${
                                shownChosenIdx === idx
                                  ? 'border-edge-strong bg-overlay'
                                  : 'border-edge-subtle hover:bg-card-hover'
                              } ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
                            >
                              <input
                                type="radio"
                                name={`resolved-${dec.id}`}
                                value={idx}
                                checked={shownChosenIdx === idx}
                                disabled={!canEdit || isBusy}
                                onChange={() => void handleReselect(dec, idx)}
                                data-testid={`resolved-option-${idx}`}
                                className="mt-1"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-primary">{opt.label}</div>
                                {opt.trade_offs && (
                                  <div className="text-xs text-muted mt-0.5 whitespace-pre-wrap">{opt.trade_offs}</div>
                                )}
                              </div>
                            </label>
                          ))}
                        </fieldset>
                      )}

                      {/* spec-247 dec-5 — optional, editable-after rationale. */}
                      {canEdit && (
                        <div>
                          {reasoningFor === dec.id ? (
                            <div className="space-y-2">
                              <TextArea
                                data-testid="reasoning-text"
                                value={reasoningDraft[dec.id] ?? ''}
                                onChange={(e) =>
                                  setReasoningDraft((prev) => ({
                                    ...prev,
                                    [dec.id]: e.target.value,
                                  }))
                                }
                                placeholder="Why this option? (Optional — the answer is already recorded.)"
                                rows={2}
                                textAreaSize="compact"
                              />
                              <div className="flex gap-2 justify-end">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setReasoningFor(null)}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  data-testid="reasoning-save"
                                  type="button"
                                  size="sm"
                                  disabled={isBusy || !(reasoningDraft[dec.id] ?? '').trim()}
                                  onClick={() => void handleSaveReasoning(dec)}
                                >
                                  Save reasoning
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              data-testid="decision-add-reasoning"
                              onClick={() => {
                                setReasoningDraft((prev) => ({
                                  ...prev,
                                  [dec.id]: prev[dec.id] ?? dec.resolution ?? '',
                                }));
                                setReasoningFor(dec.id);
                              }}
                              className="text-xs text-muted hover:text-secondary underline underline-offset-2 transition-colors"
                            >
                              {dec.resolution &&
                              dec.options &&
                              dec.chosenOptionIndex !== null &&
                              dec.resolution !== dec.options[dec.chosenOptionIndex]?.label
                                ? 'Edit reasoning'
                                : 'Add reasoning'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </details>
                )}

                <DecisionAcStrip
                  acs={acs}
                  decisionId={dec.id}
                  onJumpToAc={onJumpToAc}
                />

                {(decOpenComments || showCommentsFor === dec.id) && (
                  <div className={`mt-2 pt-2 border-t border-edge ${decOpenComments ? 'border-l-2 border-l-accent pl-2 -ml-1' : ''}`} onClick={(e) => e.stopPropagation()}>
                    <CommentTray
                      targetType="decision"
                      targetId={dec.id}
                      comments={commentsByDecision[dec.id] ?? []}
                      onCommentsChange={onCommentsChange}
                      canWrite={canWrite}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
