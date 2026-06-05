import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import {
  fetchDoc,
  fetchDocComments,
  fetchAcsForBrief,
  fetchIssues,
  fetchDocAssignees,
  archiveDoc,
  pauseDoc,
  unpauseDoc,
  updateDocStatus,
  NotFoundError,
  type AcWithVerification,
  type DocAssigneeView,
} from '../api/client';
import type { Comment, CommentType, DocWithGraph, Issue, SpecStatus, Tag } from '../api/types';
import { TagPicker } from '../components/TagPicker';
import { Spinner } from '../components/Spinner';
import { SectionCard } from '../components/SectionCard';
import { DocOutline } from '../components/DocOutline';
import { DecisionPanel } from '../components/DecisionPanel';
import { TaskPanel } from '../components/TaskPanel';
import { IssuePanel } from '../components/IssuePanel';
import { AllComments } from '../components/AllComments';
import { AcPanel } from '../components/AcPanel';
import { PhaseTabBar, type PhaseTab } from '../components/PhaseTabBar';
import { TransitionSentence } from '../components/TransitionSentence';
import { DoneSummary } from '../components/DoneSummary';
import { Badge, Button, Tabs } from '../components/ui';
import { DownloadMdDialog } from '../components/DownloadMdDialog';
import { InitPromptDialog } from '../components/InitPromptDialog';
import { useChat } from '../components/ChatContext';
import { useSwitchPosture } from '../hooks/useSwitchPosture';
import { PostureDropdown, HEADER_PILL_CLASS } from '../components/PostureDropdown';
import { countUnresolvedDecisions, toButtonPrompt, BASE_SCAFFOLD } from '@memex/shared';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { COMMENT_PARAM, parseCommentParam, commentAnchorId } from '../utils/commentDeepLink';
import { phaseDisplayName } from '../utils/phaseDisplay';
import { ShareModal } from '../components/ShareModal';
import { ShareSpecDialog } from '../components/ShareSpecDialog';
import { useHeaderSlot } from '../components/HeaderSlot';
import { SpecMenu, type SpecMenuItem } from '../components/SpecMenu';
import { RenameSpecDialog } from '../components/RenameSpecDialog';
import { MoveSpecDialog } from '../components/MoveSpecDialog';
import { specToMarkdown, downloadMarkdown, type MarkdownOptions } from '../utils/specMarkdown';
import { renderSpecInitPrompt, type InitPromptMode } from '../utils/specInitPrompt';
import { formatDate, docSeq } from '../utils/format';
import { tenantPath, getCurrentTenant } from '../utils/tenantUrl';
import { PromptButton } from '../components/PromptButton';
import { useMemexAccess } from '../hooks/useMemexAccess';
import { BylineAssignees } from '../components/BylineAssignees';
import { useDocRole } from '../hooks/useDocRole';
import { useOrgScaffoldBlocks } from '../hooks/useOrgScaffoldBlocks';

export function DocDocument() {
  // spec-64 i-3: the Spec page is also mounted at the canonical Decision / Issue
  // deep-links `specs/:id/decisions/:decId` and `specs/:id/issues/:issueId` (the
  // shape the ⌘K palette navigates to). `id` is the Spec handle; `decId`/`issueId`
  // are the optional sub-targets that open the relevant tab + scroll into view.
  const { id, decId, issueId } = useParams<{ id: string; decId?: string; issueId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // spec-111 t-8: gate every mutation surface on this doc page behind write
  // access to the current Memex. A non-member reading a public Memex sees the
  // full document, decisions, tasks, ACs, and comments — but no edit/create/
  // resolve/status controls. canWrite is threaded into the detail panels +
  // section cards below; the chat panel's read-only posture is handled in
  // DocumentShell.
  const { canWrite } = useMemexAccess(location.pathname);
  const [searchParams] = useSearchParams();
  // t-18: standard `[per dec-N]` references navigate here with `?decision=dec-N`
  // so the decisions tab is opened by default. The handle itself is used by the
  // decisions panel as a (best-effort) scroll/highlight hint. spec-64 i-3: the
  // `specs/:id/decisions/:decId` path param is the same hint via the canonical
  // deep-link, so it takes precedence over (falls back to) the query param.
  const initialDecisionHandle = decId ?? searchParams.get('decision');
  // spec-64 i-3: the `specs/:id/issues/:issueId` deep-link opens the Issues tab and
  // scroll/highlights the target issue (mirrors the decision hint). Also honours a
  // `?issue=issue-N` query param for parity with `?decision=`.
  const initialIssueHandle = issueId ?? searchParams.get('issue');
  // spec-100 ac-6: `?comment=c-N` deep-links straight to a comment — open the
  // comments tab and (once loaded) scroll/highlight the target.
  const initialCommentSeq = parseCommentParam(searchParams.get(COMMENT_PARAM));
  const chat = useChat();
  const [doc, setDoc] = useState<DocWithGraph | null>(null);
  // spec-118 t-6: a viewer's per-Spec posture. `canWrite` is org-level write
  // access to the Memex; `canEdit` narrows that to an editor posture on *this*
  // Spec. A reviewer (canWrite true, myRole 'reviewer') reads the full Spec and
  // keeps every comment/@mention affordance (those gate on canWrite), but the
  // forward-driving controls — resolve/approve decisions, phase moves — are
  // suppressed (they gate on canEdit). Tasks carry no UI mutation at all now
  // (spec-159 ac-18): they're agent-driven through MCP, so canEdit no longer
  // reaches the TaskPanel.
  // Defaults to reviewer until the role resolves, so controls don't flash in.
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // spec-159 t-6: the page holds the Spec's ACs / issues / assignees so the
  // declarative phase layouts (and DoneSummary, which fetches nothing) can read
  // them. AcPanel / IssuePanel still fetch their own live data for the active
  // phase views; these page-level copies feed the transition-sentence counts
  // (hasAcceptanceCriteria / unverifiedAcCount) and the done report.
  const [acs, setAcs] = useState<AcWithVerification[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [assignees, setAssignees] = useState<DocAssigneeView[]>([]);
  const [commentsBySection, setCommentsBySection] = useState<Record<string, Comment[]>>({});
  const [commentsByDecision, setCommentsByDecision] = useState<Record<string, Comment[]>>({});
  const [commentsByTask, setCommentsByTask] = useState<Record<string, Comment[]>>({});
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  // spec-159 t-6: the page is organised around the Spec's three working phases
  // (Plan / Build / Verify) instead of the six flat content tabs. `selectedTab`
  // is the phase view the user is browsing — it never drives the Spec's phase
  // (that's TransitionSentence's [Yes]); it only changes what's shown.
  // `null` defers to the doc's current phase, computed once the doc loads.
  const [selectedTab, setSelectedTab] = useState<PhaseTab | null>(null);
  // Plan's sub-tab (Narrative / Decisions & ACs / Comments). Build and Verify
  // have no sub-tabs. A deep-link to a decision/issue/comment picks the relevant
  // landing point below once the doc resolves.
  const [planSubTab, setPlanSubTab] = useState<'narrative' | 'decisions' | 'comments'>(
    initialCommentSeq != null
      ? 'comments'
      : initialDecisionHandle
        ? 'decisions'
        : 'narrative',
  );
  const [shareOpen, setShareOpen] = useState(false);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [showInitPromptDialog, setShowInitPromptDialog] = useState(false);
  // t-19 W3.3: chip filter lifted from AllComments. Driving it from here lets us
  // pass `?type=` through to fetchDocComments (server-side filter) instead of
  // doing a client-side pass after the fact. `null` = "All".
  const [commentTypeFilter, setCommentTypeFilter] = useState<CommentType | null>(null);
  // spec-100: collapse the comment gutters doc-wide (leaving only inline bubbles).
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);

  // spec-118 t-6: resolve the viewer's posture on this Spec. The hook is
  // null-safe before the doc loads and refetches live on 'doc_member' events.
  // `canEdit` is the conjunction of org write access and an editor posture.
  const { myRole, loading: roleLoading } = useDocRole(doc?.id ?? null);
  const canEdit = canWrite && myRole === 'editor';
  // spec-159 ac-19: a WRITABLE reviewer (org member who hasn't taken the editor
  // posture on this Spec) gets a review-oriented phase block — a row of
  // review-action prompts and a reviewer handoff line — in place of the
  // editor's PhaseTabBar + TransitionSentence. Editors and read-only visitors
  // (canWrite false) keep the existing block untouched. The posture itself
  // (and the switch between editing/reviewing) lives in the header's
  // PostureDropdown pill, not in this block.
  const isWritableReviewer = canWrite && myRole === 'reviewer';
  // The posture switch behind the header pill — promote/demote + role refetch
  // (the role flip then swaps the phase block). Null-safe before the doc loads.
  const switchPosture = useSwitchPosture(doc?.id ?? '');
  // spec-159 ac-17: Org scaffold appends for the phase handoff line's
  // PromptButton — threaded into toButtonPrompt exactly as OpeningTurn does.
  const orgBlocks = useOrgScaffoldBlocks();

  const applyComments = useCallback((result: Awaited<ReturnType<typeof fetchDocComments>>) => {
    const sMap: Record<string, Comment[]> = {};
    for (const entry of result.sections) sMap[entry.section.id] = entry.comments;
    setCommentsBySection(sMap);

    const dMap: Record<string, Comment[]> = {};
    for (const entry of result.decisions) dMap[entry.decision.id] = entry.comments;
    setCommentsByDecision(dMap);

    const tMap: Record<string, Comment[]> = {};
    for (const entry of result.tasks) tMap[entry.task.id] = entry.comments;
    setCommentsByTask(tMap);
  }, []);

  // spec-100 ac-6: once the comments have rendered, scroll the deep-linked
  // comment into view and briefly highlight it. Runs when the target seq or the
  // loaded comment sets change; the element only exists while the Plan view's
  // Comments sub-tab is active (the initial planSubTab handles that). Best-effort
  // — if the target is filtered out (e.g. resolved under the default open
  // filter) it simply won't be found.
  useEffect(() => {
    if (initialCommentSeq == null || planSubTab !== 'comments') return;
    const el = document.getElementById(commentAnchorId(initialCommentSeq));
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-accent', 'rounded-md');
    const t = setTimeout(() => el.classList.remove('ring-2', 'ring-accent', 'rounded-md'), 2000);
    return () => clearTimeout(t);
  }, [initialCommentSeq, planSubTab, commentsBySection, commentsByDecision, commentsByTask]);

  useEffect(() => {
    if (!id) return;

    const types = commentTypeFilter ? [commentTypeFilter] : undefined;
    fetchDoc(id)
      .then((d) => {
        // Per doc-30 dec-4 (post-b-105 rename): typed top-level routes. If the
        // URL path segment doesn't match the doc's type, redirect to the
        // canonical one. Catches both directions: legacy `/docs/spec-N` links
        // → `/specs/spec-N`, and any accidental `/specs/doc-N` → `/docs/doc-N`.
        // Preserves the URL identifier (UUID or handle) and any query string
        // verbatim.
        const isSpec = d.docType === 'spec';
        const onDocsPath = location.pathname.match(/\/docs\/[^/]+$/);
        const onSpecsPath = location.pathname.match(/\/specs\/[^/]+$/);
        if (isSpec && onDocsPath) {
          const canonical = location.pathname.replace(/\/docs\//, '/specs/');
          navigate({ pathname: canonical, search: location.search }, { replace: true });
          return;
        }
        if (!isSpec && onSpecsPath) {
          const canonical = location.pathname.replace(/\/specs\//, '/docs/');
          navigate({ pathname: canonical, search: location.search }, { replace: true });
          return;
        }
        setDoc(d);
        fetchDocComments(d.id, types).then(applyComments).catch(console.error);
      })
      .catch((err) => {
        if (err instanceof NotFoundError) {
          setNotFound(true);
        } else {
          setError(err.message);
        }
      })
      .finally(() => setLoading(false));
    // location.pathname/search are intentionally excluded from deps — they
    // change as a side effect of the canonical-URL redirect above, and we
    // don't want to re-fetch on that change. `id` already triggers re-fetch
    // when the route param changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, applyComments, commentTypeFilter, navigate]);

  // spec-159 t-6: pull the Spec's ACs / issues / assignees alongside the doc.
  // These feed the transition-sentence counts and the done report; they refresh
  // on every doc id change and on the live change stream (via reloadAux below).
  const reloadAux = useCallback((docId: string) => {
    fetchAcsForBrief(docId).then(setAcs).catch(console.error);
    fetchIssues(docId).then(setIssues).catch(console.error);
    fetchDocAssignees(docId).then(setAssignees).catch(() => setAssignees([]));
  }, []);

  useEffect(() => {
    if (doc?.id) reloadAux(doc.id);
  }, [doc?.id, reloadAux]);

  // spec-158 ac-17 / ac-4 / ac-11: an issue deep-link (`specs/spec-N/issues/issue-N`
  // or `?issue=issue-N`) must land on a phase view that actually renders IssuePanel
  // so `highlightIssueHandle` reaches it — including on a fresh full-page load.
  // spec-159's restructure only mounts IssuePanel under the Build / Verify layouts;
  // a Spec sitting in draft/plan/done would otherwise drop the highlight. When a
  // deep-linked issue is present and the doc's current phase view is Plan (the one
  // phase tab without IssuePanel), browse to Build once. Runs a single time on the
  // first doc load; the user can still navigate away afterwards.
  const issueDeepLinkLandedRef = useRef(false);
  useEffect(() => {
    if (issueDeepLinkLandedRef.current) return;
    if (!doc || !initialIssueHandle) return;
    issueDeepLinkLandedRef.current = true;
    const phaseTab =
      doc.status === 'build' ? 'build' : doc.status === 'verify' ? 'verify' : null;
    // Build / Verify already show IssuePanel; only Plan (draft/plan) and the
    // done report need redirecting to a tab that mounts it.
    if (phaseTab === null) setSelectedTab('build');
  }, [doc, initialIssueHandle]);

  // Connect doc ID to chat (only on mount/unmount, not on doc reload)
  useEffect(() => {
    if (doc) chat.setDocId(doc.id);
  }, [doc?.id]);

  useEffect(() => {
    return () => {
      chat.setDocId(null);
      chat.setDoc(null);
    };
  }, []);

  // Keep chat doc state in sync on reload
  useEffect(() => {
    if (doc) chat.setDoc(doc);
  }, [doc]);

  const sortedSections = doc
    ? [...doc.sections].sort((a, b) => a.seq - b.seq)
    : [];

  // Comment counts (across all entity types)
  const commentCounts: Record<string, number> = {};
  for (const [id, comments] of Object.entries(commentsBySection)) {
    commentCounts[id] = comments.filter((c) => !c.resolvedAt).length;
  }
  for (const [id, comments] of Object.entries(commentsByDecision)) {
    commentCounts[id] = comments.filter((c) => !c.resolvedAt).length;
  }
  for (const [id, comments] of Object.entries(commentsByTask)) {
    commentCounts[id] = comments.filter((c) => !c.resolvedAt).length;
  }
  const totalCommentCount = Object.values(commentCounts).reduce((a, b) => a + b, 0);

  // spec-123 t-2: feed the open comment count into the chat context so the
  // OpeningTurn's readiness computation can gate the "Resolve Comments" helper
  // (ac-9). Open comment counts aren't carried on the doc graph — they're
  // derived here from the fetched comment sets — so this is the sync point.
  useEffect(() => {
    chat.setOpenCommentCount(totalCommentCount);
  }, [totalCommentCount]);


  const handleSelectSection = useCallback((sectionId: string) => {
    // The Narrative lives under the Plan view's first sub-tab.
    setSelectedTab('plan');
    setPlanSubTab('narrative');
    setSelectedSectionId(sectionId);
    const index = sortedSections.findIndex((s) => s.id === sectionId);
    if (index >= 0) {
      setTimeout(() => {
        document.getElementById(`section-${index + 1}`)?.scrollIntoView({ behavior: 'smooth' });
      }, 0);
    }
  }, [sortedSections]);

  // AllComments' onTabChange hands back a section/decision/task target tab. The
  // only navigable destinations that still exist live under the Plan view, so
  // route them there (Narrative for sections, Decisions & ACs for decisions).
  const handleTabChange = useCallback((tab: string) => {
    setSelectedTab('plan');
    if (tab === 'decisions') setPlanSubTab('decisions');
    else if (tab === 'document') setPlanSubTab('narrative');
  }, []);

  // Cross-view nav for the DecisionAcStrip pills: when a pill is clicked in the
  // Decisions & ACs column, focus the AC and surface it. Both panels live in the
  // same Plan sub-tab (two columns), so we just hand AcPanel the focus id; it
  // scrolls + highlights, then calls onFocusConsumed.
  const [focusedAcId, setFocusedAcId] = useState<string | null>(null);
  const handleJumpToAc = useCallback((acId: string) => {
    setFocusedAcId(acId);
    setSelectedTab('plan');
    setPlanSubTab('decisions');
  }, []);

  const handleSectionCommentsChange = useCallback(
    (sectionId: string, comments: Comment[]) => {
      setCommentsBySection((prev) => ({ ...prev, [sectionId]: comments }));
    },
    []
  );

  const handleDecisionCommentsChange = useCallback(
    (decisionId: string, comments: Comment[]) => {
      setCommentsByDecision((prev) => ({ ...prev, [decisionId]: comments }));
    },
    []
  );

  const handleTaskCommentsChange = useCallback(
    (taskId: string, comments: Comment[]) => {
      setCommentsByTask((prev) => ({ ...prev, [taskId]: comments }));
    },
    []
  );

  // spec-136 t-6: fold the picker's resolved full tag set back into the doc
  // payload so chips on the header re-render without a full reloadDoc. The
  // server already returns the doc's complete tag set after each write.
  const handleTagsChange = useCallback((tags: Tag[]) => {
    setDoc((prev) => (prev ? { ...prev, tags } : prev));
  }, []);

  const reloadDoc = useCallback(() => {
    if (!id) return;
    const types = commentTypeFilter ? [commentTypeFilter] : undefined;
    fetchDoc(id).then((d) => {
      setDoc(d);
      fetchDocComments(d.id, types).then(applyComments).catch(console.error);
      reloadAux(d.id);
    }).catch(console.error);
  }, [id, applyComments, commentTypeFilter, reloadAux]);

  // Refetch when any source (agent, MCP, REST, other clients) mutates this document
  useDocChangeStream(doc?.id ?? null, reloadDoc);

  const headerActions = useMemo(() => {
    if (!doc) return null;
    // spec-111 t-8: a non-member (read-only) sees only the read-safe header
    // actions — Download MD. Every phase/resolve/refresh control and the
    // mutating SpecMenu items (rename/share/pause/move/archive) are suppressed.
    if (!canWrite) {
      return (
        <button
          type="button"
          aria-label="Download Spec"
          onClick={() => setShowDownloadDialog(true)}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 11l5 5 5-5M12 4v12" />
          </svg>
        </button>
      );
    }
    return (
      <>
        {/* spec-159 t-6/t-7: the next-step actions (Resolve Decisions, Resolve
            Comments, Refresh Spec, the verify-phase PromptButton) and the
            phase-control affordance no longer live in the header. The PhaseDropdown
            is gone, replaced by the in-page PhaseTabBar + TransitionSentence below
            the role controls; the page itself carries readiness + handoffs. The
            header keeps the posture pill + Share / Download / menu (all on
            canWrite). */}
        {/* spec-159 ac-19 (amended): MY posture on this Spec — a Google-Docs-
            style Editing / Reviewing mode pill. Page-global (it gates decision
            resolution, phase moves, AC mutations on every tab), hence header
            chrome rather than the phase block. Gated on the role having
            resolved so the pill never flashes the wrong mode. */}
        {doc.docType === 'spec' && !roleLoading && (
          <PostureDropdown myRole={myRole} onSelect={(target) => switchPosture(target)} />
        )}
        {/* Share — the Spec's canonical URL with a Copy button. Pill chrome
            shared with the posture dropdown so the header controls match. */}
        <button type="button" className={HEADER_PILL_CLASS} onClick={() => setShareLinkOpen(true)}>
          Share
        </button>
        <button
          type="button"
          aria-label="Download Spec"
          onClick={() => setShowDownloadDialog(true)}
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 11l5 5 5-5M12 4v12" />
          </svg>
        </button>
        <SpecMenu
          items={[
            { label: 'Rename', onClick: () => setRenameOpen(true) },
            { label: 'Share', onClick: () => setShareOpen(true) },
            { label: 'Download MD', onClick: () => setShowDownloadDialog(true), separatorBefore: true },
            { label: 'Spec Coding Agent', onClick: () => setShowInitPromptDialog(true) },
            {
              label: doc.pausedAt ? 'Unpause' : 'Pause',
              separatorBefore: true,
              onClick: async () => {
                try {
                  await (doc.pausedAt ? unpauseDoc(doc.id) : pauseDoc(doc.id));
                  await reloadDoc();
                } catch (err) {
                  window.alert(err instanceof Error ? err.message : 'Failed to update pause state');
                }
              },
            },
            { label: 'Move to another memex', onClick: () => setMoveOpen(true) },
            {
              label: 'Archive',
              danger: true,
              separatorBefore: true,
              onClick: async () => {
                if (!window.confirm(`Archive "${doc.title}"? It'll be hidden from the board.`)) return;
                try {
                  await archiveDoc(doc.id);
                  navigate(tenantPath('/specs'));
                } catch (err) {
                  window.alert(err instanceof Error ? err.message : 'Failed to archive spec');
                }
              },
            },
          ] satisfies SpecMenuItem[]}
          ariaLabel={`Actions for ${doc.title}`}
        />
      </>
    );
  }, [doc, reloadDoc, navigate, totalCommentCount, canWrite, canEdit, myRole, roleLoading, switchPosture]);

  useHeaderSlot(headerActions);

  const handleDownloadConfirm = useCallback((options: MarkdownOptions) => {
    if (!doc) return;
    const md = specToMarkdown(
      doc,
      { bySection: commentsBySection, byDecision: commentsByDecision, byTask: commentsByTask },
      options,
    );
    const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    downloadMarkdown(`${doc.handle}${slug ? `-${slug}` : ''}.md`, md);
    setShowDownloadDialog(false);
  }, [doc, commentsBySection, commentsByDecision, commentsByTask]);

  const handleInitPromptCopy = useCallback(async (mode: InitPromptMode) => {
    if (!doc) return;
    const prompt = renderSpecInitPrompt(doc, totalCommentCount, mode);
    await navigator.clipboard.writeText(prompt);
  }, [doc, totalCommentCount]);

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link to={tenantPath('/specs')} className="text-sm text-secondary hover:text-primary mb-8 inline-block">
          &larr; Back to specs
        </Link>
        <div className="text-secondary text-center py-16 border border-edge rounded-lg bg-panel">
          Spec not found
        </div>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link to={tenantPath('/specs')} className="text-sm text-secondary hover:text-primary mb-8 inline-block">
          &larr; Back to specs
        </Link>
        <div className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text">
          Failed to load spec: {error}
        </div>
      </div>
    );
  }

  const decs = doc.decisions ?? [];
  const ts = doc.tasks ?? [];

  const sectionCommentCount = Object.values(commentsBySection)
    .reduce((n, cs) => n + cs.filter((c) => !c.resolvedAt).length, 0);
  const decisionCommentCount = Object.values(commentsByDecision)
    .reduce((n, cs) => n + cs.filter((c) => !c.resolvedAt).length, 0);

  // ── spec-159 t-6: phase view + the transition-sentence counts ──────────────
  // The Spec's live phase. `done` is handled separately (DoneSummary takes over
  // the content area) — every other phase routes through the PhaseTabBar.
  const phase = doc.status as SpecStatus;
  // The tab the phase makes "current" (draft → plan; done → none). The view the
  // user is *browsing* is `selectedTab` once they've clicked, else this.
  const currentTab: PhaseTab | null =
    phase === 'draft' || phase === 'plan'
      ? 'plan'
      : phase === 'build'
        ? 'build'
        : phase === 'verify'
          ? 'verify'
          : null;
  const viewedTab: PhaseTab = selectedTab ?? currentTab ?? 'plan';

  // ── spec-159 ac-17: the next-action handoff line ───────────────────────────
  // Beneath the Rubicon line, a one-sentence "Copy a prompt to …" handoff keyed
  // to the Spec's CURRENT phase (not the browsed tab). It renders for every
  // viewer — copying a prompt is read-only. draft + plan share the plan handoff;
  // build / verify each get theirs; done shows none. Each entry names the
  // Scaffold PromptButtonNode and the sentence that trails the "Copy" link.
  const tenant = getCurrentTenant();
  const handoffContext = {
    namespace: tenant?.namespace ?? '',
    memex: tenant?.memex ?? '',
    handle: doc.handle,
    title: doc.title,
    url: `${window.location.origin}/${tenant?.namespace ?? ''}/${tenant?.memex ?? ''}/specs/${doc.handle}`,
  };

  // ── spec-159 ac-19: the writable reviewer's review-action row ──────────────
  // The same four scaffold chat prompts the OpeningTurn reviewer set surfaces
  // (Summarise / Security / Design / Architecture). Each resolves its prose from
  // BASE_SCAFFOLD via toButtonPrompt (interpolating the same context the handoff
  // line uses) and sends it through the existing chat — mirroring how
  // OpeningTurn's chat_prompt arm threads onSendPrompt → sendMessage.
  const REVIEW_ACTIONS: { label: string; buttonId: string }[] = [
    { label: 'Summarise Spec', buttonId: 'opening-review-summarise' },
    { label: 'Security review', buttonId: 'opening-review-security' },
    { label: 'Design review', buttonId: 'opening-review-design' },
    { label: 'Architecture review', buttonId: 'opening-review-architecture' },
  ];
  const sendReviewPrompt = (buttonId: string) => {
    const prompt = toButtonPrompt({
      dataset: BASE_SCAFFOLD,
      buttonId,
      context: handoffContext,
      orgBlocks,
    });
    if (prompt === null) {
      const message = `DocDocument: no PromptButtonNode found for buttonId="${buttonId}"`;
      if (import.meta.env.DEV) throw new Error(message);
      // eslint-disable-next-line no-console
      console.error(message);
      return;
    }
    chat.sendMessage(prompt);
  };

  const handoff: {
    buttonId: string;
    sentence: React.ReactNode;
    /** Prose before the link + the clickable words (default "Copy"). */
    sentencePrefix?: React.ReactNode;
    linkText?: string;
    /** Plain-text FULL sentence for the accessible name (needed when sentence is a node). */
    sentenceLabel?: string;
  } | null =
    // spec-164 issue-1: draft shows NO handoff line. Originally spec-159 ac-17
    // shared the plan handoff between draft and plan (one arm,
    // `phase === 'draft' || phase === 'plan'`). But dec-3 gates the Decisions &
    // ACs panels in draft behind an empty-state directive ("Move this spec to
    // Specify to start capturing Decisions and ACs.") — the draft posture is to
    // invite the move to Specify FIRST. A coding-agent prompt to "create
    // Decisions and ACs" while in draft contradicts that gate-the-invitation
    // principle, so draft now yields null (no handoff); plan keeps plan-handoff.
    phase === 'plan'
      ? {
          buttonId: 'plan-handoff',
          // "Copy and paste *this prompt* into your coding agent to create
          // **Decisions** and **ACs**." — the link sits on "this prompt";
          // entities bold. "ACs" stays abbreviated: the Rubicon line above
          // already spells out "Acceptance Criteria (ACs)" in full.
          sentencePrefix: 'Copy and paste ',
          linkText: 'this prompt',
          sentence: (
            <>
              into your coding agent to create{' '}
              <strong className="font-semibold">Decisions</strong> and{' '}
              <strong className="font-semibold">ACs</strong>.
            </>
          ),
          sentenceLabel:
            'Copy and paste this prompt into your coding agent to create Decisions and ACs.',
        }
      : phase === 'build'
        ? {
            buttonId: 'opening-build-handoff',
            // "Copy and paste *this prompt* into your coding agent to complete
            // the **Tasks** and build this spec."
            sentencePrefix: 'Copy and paste ',
            linkText: 'this prompt',
            sentence: (
              <>
                into your coding agent to complete the{' '}
                <strong className="font-semibold">Tasks</strong> and build this spec.
              </>
            ),
            sentenceLabel:
              'Copy and paste this prompt into your coding agent to complete the Tasks and build this spec.',
          }
        : phase === 'verify'
          ? {
              buttonId: 'verify-spec',
              // "Copy and paste *this prompt* into your coding agent to verify
              // this spec against its **ACs**." — "ACs" stays abbreviated: the
              // Rubicon line above already spells out "Acceptance Criteria
              // (ACs)" in full.
              sentencePrefix: 'Copy and paste ',
              linkText: 'this prompt',
              sentence: (
                <>
                  into your coding agent to verify this spec against its{' '}
                  <strong className="font-semibold">ACs</strong>.
                </>
              ),
              sentenceLabel:
                'Copy and paste this prompt into your coding agent to verify this spec against its ACs.',
            }
          : null; // done → no handoff line

  // Counts feeding the in-situ phase directives — derived from the page's
  // already-fetched AC / task sets plus the shared open-decision count.
  // `hasAcceptanceCriteria` informs plan→build; `openTaskCount` build→verify;
  // `unverifiedAcCount` verify→done. Only active ACs count toward verification.
  const activeAcs = acs.filter((a) => a.ac.status === 'active');
  const hasAcceptanceCriteria = activeAcs.length > 0;
  const unverifiedAcCount = activeAcs.filter((a) => a.verificationState !== 'verified').length;
  const openTaskCount = ts.filter((t) => t.status !== 'complete').length;
  const openDecisionCount = countUnresolvedDecisions(
    decs.map((d) => ({
      id: d.id,
      createdAt: d.createdAt,
      resolvedAt: d.resolvedAt,
      status: d.status,
    })),
  );

  // spec-159 dec-4 (amended): the readiness rubric is ADVISORY. The transition
  // sentence always offers the move; this in-situ directive spans the full
  // width ABOVE the two-column grid (one line per phase layout, fragments
  // concatenated) so the columns always start aligned — a warning on one list
  // no longer pushes that column down past the other. Copy mirrors the spec's
  // "Rubicon line — copy set" section: emphasised entity + "must be …",
  // consecutive same-requirement fragments merging their entities
  // ("Decisions and ACs must be created…"). Each phase's line renders only on
  // that phase's own layout — a directive about plan→build is noise while
  // browsing the build tab from verify.
  const pluralise = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  type DirectivePart = { em: string; rest: string };
  const directiveLine = (parts: DirectivePart[], target: string) => {
    if (parts.length === 0) return null;
    // Merge consecutive same-requirement fragments: their entities join with
    // "and" ahead of one shared verb phrase. Distinct requirements also join
    // with "and" ("4 Decisions must be resolved and ACs must be created").
    const groups: { ems: string[]; rest: string }[] = [];
    for (const p of parts) {
      const last = groups[groups.length - 1];
      if (last && last.rest === p.rest) last.ems.push(p.em);
      else groups.push({ ems: [p.em], rest: p.rest });
    }
    return (
      <p
        data-testid="phase-directive"
        className="mb-3 text-sm text-status-warning-text flex items-start gap-1.5"
      >
        <span aria-hidden="true">⚠</span>
        <span>
          {groups.map((g, gi) => (
            <span key={gi}>
              {gi > 0 && ' and '}
              {g.ems.map((em, ei) => (
                <span key={ei}>
                  {ei > 0 && ' and '}
                  <strong className="font-semibold">{em}</strong>
                </span>
              ))}{' '}
              {g.rest}
            </span>
          ))}{' '}
          before this spec can move to {phaseDisplayName(target)}.
        </span>
      </p>
    );
  };
  const planDirective = directiveLine(
    phase === 'plan'
      ? [
          ...(decs.length === 0
            ? [{ em: 'Decisions', rest: 'must be created' }]
            : openDecisionCount > 0
              ? [{ em: pluralise(openDecisionCount, 'Decision'), rest: 'must be resolved' }]
              : []),
          ...(!hasAcceptanceCriteria
            ? [{ em: 'Acceptance Criteria (ACs)', rest: 'must be created' }]
            : []),
        ]
      : [],
    'build',
  );
  const buildDirective = directiveLine(
    phase === 'build'
      ? ts.length === 0
        ? // The zero-task hole: a build with no tasks hasn't built anything.
          [{ em: 'Tasks', rest: 'must be created and completed' }]
        : openTaskCount > 0
          ? [
              {
                em: pluralise(openTaskCount, 'Task'),
                rest: 'must be completed (or kicked to Issues)',
              },
            ]
          : []
      : [],
    'verify',
  );
  const verifyDirective = directiveLine(
    phase === 'verify'
      ? !hasAcceptanceCriteria
        ? // Same hole: nothing to verify against.
          [{ em: 'Acceptance Criteria (ACs)', rest: 'must be created and verified' }]
        : unverifiedAcCount > 0
          ? [
              {
                em:
                  unverifiedAcCount === 1
                    ? '1 Acceptance Criterion (AC)'
                    : `${unverifiedAcCount} Acceptance Criteria (ACs)`,
                rest: 'must be verified',
              },
            ]
          : []
      : [],
    'done',
  );

  // Plan's three sub-tabs. Build / Verify carry no sub-tab bar (ac-11).
  const planSubTabs = [
    { id: 'narrative', label: 'Narrative', count: sectionCommentCount, countVariant: 'warning' as const },
    { id: 'decisions', label: 'Decisions & ACs', count: decisionCommentCount, countVariant: 'warning' as const },
    { id: 'comments', label: 'Comments', count: totalCommentCount, countVariant: 'warning' as const },
  ];

  // ── Reusable content fragments — each phase layout below composes these ─────
  const narrativeView = (
    <div className="flex gap-8 items-start">
      <div className="flex-1 space-y-3 min-w-0">
        {totalCommentCount > 0 && (
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="toggle-comment-gutter"
              onClick={() => setCommentsCollapsed((v) => !v)}
              className="text-xs text-secondary hover:text-primary inline-flex items-center gap-1 px-2 py-1 rounded-md border border-edge hover:bg-overlay"
            >
              {commentsCollapsed ? 'Show comments' : 'Hide comments'}
            </button>
          </div>
        )}
        {sortedSections.map((section, index) => (
          <SectionCard
            key={section.id}
            section={section}
            sectionNumber={index + 1}
            isSelected={section.id === selectedSectionId}
            commentCount={commentCounts[section.id] ?? 0}
            comments={commentsBySection[section.id] ?? []}
            onCommentsChange={handleSectionCommentsChange}
            onSelect={setSelectedSectionId}
            canWrite={canWrite}
            canEdit={canEdit}
            commentsCollapsed={commentsCollapsed}
            onExpandComments={() => setCommentsCollapsed(false)}
          />
        ))}
      </div>
      <aside className="w-48 shrink-0 hidden lg:block sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-y-auto">
        <DocOutline
          doc={doc}
          sections={sortedSections}
          activeSectionId={selectedSectionId}
          commentCounts={commentCounts}
          onSectionClick={handleSelectSection}
        />
      </aside>
    </div>
  );

  const decisionPanel = (
    <DecisionPanel
      docId={doc.id}
      specPhase={phase}
      decisions={decs}
      commentsByDecision={commentsByDecision}
      onCommentsChange={handleDecisionCommentsChange}
      onUpdate={reloadDoc}
      highlightDecisionHandle={initialDecisionHandle}
      onJumpToAc={handleJumpToAc}
      canWrite={canWrite}
      canEdit={canEdit}
    />
  );

  const acPanel = (
    <AcPanel
      docId={doc.id}
      specPhase={phase}
      focusedAcId={focusedAcId}
      onFocusConsumed={() => setFocusedAcId(null)}
    />
  );

  const taskPanel = (
    <TaskPanel
      docId={doc.id}
      doc={doc}
      tasks={ts}
      commentsByTask={commentsByTask}
      onCommentsChange={handleTaskCommentsChange}
      onUpdate={reloadDoc}
      canWrite={canWrite}
    />
  );

  const issuePanel = (
    <IssuePanel
      docId={doc.id}
      canWrite={canWrite}
      onUpdate={reloadDoc}
      highlightIssueHandle={initialIssueHandle}
    />
  );

  const allCommentsView = (
    <AllComments
      sections={sortedSections}
      decisions={decs}
      tasks={ts}
      commentsBySection={commentsBySection}
      commentsByDecision={commentsByDecision}
      commentsByTask={commentsByTask}
      onNavigateToSection={handleSelectSection}
      onTabChange={handleTabChange}
      filter={commentTypeFilter}
      onFilterChange={setCommentTypeFilter}
    />
  );

  // Two-column shell used by the Build (Tasks | Issues), Verify (AC | Issues),
  // and Plan's Decisions & ACs (Decisions | AC) layouts. The phase directive
  // renders full-width ABOVE this shell (one concatenated line), never inside
  // a column, so the two panels always start on the same line. On mobile
  // (single column) cells stack in natural reading order.
  const twoCol = (
    left: React.ReactNode,
    right: React.ReactNode,
    directive: React.ReactNode = null,
  ) => (
    <>
      {directive}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 items-start">
        <div className="min-w-0 mb-6 lg:mb-0">{left}</div>
        <div className="min-w-0">{right}</div>
      </div>
    </>
  );

  // ── The declarative phase → layout map (spec-159: explicitly a plain data
  //    structure so the per-phase composition is cheap to rearrange). `done`
  //    isn't here — DoneSummary replaces the whole content area below. `draft`
  //    shares the `plan` layout (its home tab). Each entry says whether the
  //    phase carries a sub-tab bar and what it renders. ──────────────────────
  const PHASE_LAYOUTS: Record<PhaseTab, { hasSubTabs: boolean; render: () => React.ReactNode }> = {
    plan: {
      hasSubTabs: true,
      render: () => (
        <>
          {/* Classic underline tabs (full-width baseline + active bar) — the
              pill variant read as buttons, not tabs. */}
          <Tabs
            tabs={planSubTabs}
            activeTab={planSubTab}
            onChange={(t) => setPlanSubTab(t as typeof planSubTab)}
            variant="underline"
          />
          {planSubTab === 'narrative' && narrativeView}
          {planSubTab === 'decisions' && twoCol(decisionPanel, acPanel, planDirective)}
          {planSubTab === 'comments' && allCommentsView}
        </>
      ),
    },
    build: {
      hasSubTabs: false,
      render: () => twoCol(taskPanel, issuePanel, buildDirective),
    },
    verify: {
      hasSubTabs: false,
      render: () => twoCol(acPanel, issuePanel, verifyDirective),
    },
  };

  return (
    <div className="px-6 py-4">
      {/* Document header */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-heading">
          {docSeq(doc.handle) && (
            <span className="text-muted font-normal mr-2">{docSeq(doc.handle)}.</span>
          )}
          {doc.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-muted">
          {doc.docType !== 'spec' && <Badge status={doc.status} />}
          <span>{doc.creator?.name?.trim() || doc.creator?.email?.trim() || 'Unknown'}</span>
          <span className="opacity-40">&middot;</span>
          <span>{formatDate(doc.createdAt)}</span>
          {/* spec-159: Spec assignment + tags live on the byline now — assignee
              chips + a single "+ Assign" pill, then the tag chips + "+ Tag"
              (spec-136), all uniform h-6 pills. Specs only (the byline div is
              shared with non-Spec docs). */}
          {doc.docType === 'spec' && (
            <>
              <span className="opacity-40">&middot;</span>
              <BylineAssignees docId={doc.id} />
              <span className="opacity-40">&middot;</span>
              <TagPicker docId={doc.id} tags={doc.tags ?? []} onTagsChange={handleTagsChange} />
            </>
          )}
        </div>
        {/* spec-118 t-6: assignment moved onto the byline (spec-159, see above).
            The per-Spec posture (editor/reviewer) switching UI left this page in
            spec-159 — it's handled elsewhere; SpecRoleControls is no longer
            rendered here. */}
      </div>

      {shareOpen && <ShareModal docId={doc.id} onClose={() => setShareOpen(false)} />}
      {/* The header Share pill — the Spec's canonical URL with a Copy button
          (guest share-link management stays in ShareModal via the ⋯ menu). */}
      {shareLinkOpen && (
        <ShareSpecDialog url={handoffContext.url} onClose={() => setShareLinkOpen(false)} />
      )}
      {renameOpen && (
        <RenameSpecDialog
          docId={doc.id}
          currentTitle={doc.title}
          onClose={() => setRenameOpen(false)}
          onRenamed={reloadDoc}
        />
      )}
      {moveOpen && (
        <MoveSpecDialog
          docId={doc.id}
          title={doc.title}
          decisionCount={decs.length}
          taskCount={ts.length}
          sectionCommentCount={sectionCommentCount}
          onClose={() => setMoveOpen(false)}
        />
      )}

      {/* spec-159 ac-19: a WRITABLE REVIEWER gets a review-oriented phase block
          in place of the editor's PhaseTabBar + TransitionSentence. It has no
          tabs (a reviewer browses only the current phase's layout) and offers no
          forward move — a reviewer observes. EDITORS and read-only visitors
          (canWrite false) fall through to the existing block below, unchanged.
          `done` collapses into the DoneSummary for everyone. */}
      {doc.docType === 'spec' && phase !== 'done' && isWritableReviewer ? (
        <div className="mb-4 space-y-2">
          {/* The posture itself ("you are reviewing", switch to editing) lives
              in the header's PostureDropdown pill — this block carries only the
              review actions and the handoff line. */}
          {/* Review action row — the four scaffold review prompts, sent through
              the chat (mirrors OpeningTurn's reviewer set + chat_prompt arm). */}
          <div
            data-testid="review-action-row"
            className="flex flex-wrap items-center gap-2 pt-1"
          >
            {REVIEW_ACTIONS.map((action) => (
              <Button
                key={action.buttonId}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => sendReviewPrompt(action.buttonId)}
              >
                {action.label}
              </Button>
            ))}
          </div>
          {/* Reviewer handoff line — copy a coding-agent prompt to conduct the
              review from there. Same sentence form as the editor handoff. */}
          <div data-testid="review-handoff-line">
            <PromptButton
              buttonId="review-handoff"
              context={handoffContext}
              orgBlocks={orgBlocks}
              sentencePrefix="You can copy and paste "
              linkText="this prompt"
              sentence="into your coding agent if you prefer to conduct the review from there."
              sentenceLabel="You can copy and paste this prompt into your coding agent if you prefer to conduct the review from there."
            />
          </div>
        </div>
      ) : (
        /* spec-159 t-6/t-7: the phase control is now an in-page affordance. The
           PhaseTabBar browses phase views (Plan / Build / Verify) without ever
           moving the Spec; the TransitionSentence beneath it is the *only* phase
           mutation — one [Yes], no modal. Specs only. The sentence renders for
           every viewer (it's the page's phase status line); the Yes itself gates
           on canEdit. `done` collapses both into the DoneSummary. */
        doc.docType === 'spec' &&
        phase !== 'done' && (
          <div className="mb-4 space-y-2">
            <PhaseTabBar
              currentPhase={phase}
              selectedTab={viewedTab}
              onSelect={(t) => setSelectedTab(t)}
            />
            <TransitionSentence
              doc={{ id: doc.id }}
              currentPhase={phase}
              viewedTab={viewedTab}
              canTransition={canEdit}
              totalDecisionCount={decs.length}
              openDecisionCount={openDecisionCount}
              hasAcceptanceCriteria={hasAcceptanceCriteria}
              totalTaskCount={ts.length}
              openTaskCount={openTaskCount}
              unverifiedAcCount={unverifiedAcCount}
              onTransitioned={() => {
                // The view follows the move: clear the browsed-tab pin so
                // `viewedTab` falls back to the (re-fetched) current phase's
                // home tab.
                setSelectedTab(null);
                reloadDoc();
              }}
              onCancelBrowse={() => setSelectedTab(null)}
            />
            {/* spec-159 ac-17: the next-action handoff line — a "Copy a prompt
                to …" sentence keyed to the CURRENT phase. Renders for every
                viewer (copying a prompt is read-only); absent at `done`. */}
            {handoff && (
              <div data-testid="phase-handoff-line">
                <PromptButton
                  buttonId={handoff.buttonId}
                  context={handoffContext}
                  orgBlocks={orgBlocks}
                  sentence={handoff.sentence}
                  sentencePrefix={handoff.sentencePrefix}
                  linkText={handoff.linkText}
                  sentenceLabel={handoff.sentenceLabel}
                />
              </div>
            )}
          </div>
        )
      )}

      {/* Content area. `done` → the retrospective report replaces it entirely;
          every other phase renders its declarative layout. Non-Spec docs (no
          phase layer) fall back to the Narrative view. Reviewers have no phase
          tabs, so `viewedTab` stays pinned to the current phase's layout. */}
      {doc.docType === 'spec' && phase === 'done' ? (
        <DoneSummary
          doc={doc}
          decisions={decs}
          tasks={ts}
          acs={acs}
          issues={issues}
          people={assignees}
          /* spec-164 dec-5: the one deliberate door back from done. Gates on
             the same editor posture as the transition sentence's Yes; the
             status write lives here (DoneSummary stays fetch-free, ac-9).
             After the write the view follows the move, exactly like
             TransitionSentence's onTransitioned. */
          canReopen={canEdit}
          onReopen={async () => {
            await updateDocStatus(doc.id, 'verify');
            setSelectedTab(null);
            reloadDoc();
          }}
        />
      ) : doc.docType !== 'spec' ? (
        narrativeView
      ) : (
        PHASE_LAYOUTS[viewedTab].render()
      )}

      {showDownloadDialog && (
        <DownloadMdDialog
          onConfirm={handleDownloadConfirm}
          onClose={() => setShowDownloadDialog(false)}
        />
      )}

      {showInitPromptDialog && (
        <InitPromptDialog
          onCopy={handleInitPromptCopy}
          onClose={() => setShowInitPromptDialog(false)}
        />
      )}
    </div>
  );
}
