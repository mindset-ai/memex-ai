import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import {
  fetchDoc,
  fetchDocComments,
  fetchAcsForBrief,
  fetchIssues,
  fetchDocAssignees,
  archiveDoc,
  updateDocStatus,
  resetHandholdDemo,
  NotFoundError,
  type AcWithVerification,
  type DocAssigneeView,
} from '../api/client';
import type { Comment, DocWithGraph, Issue, SpecStatus, Tag } from '../api/types';
import { TagPicker } from '../components/TagPicker';
import { CodeGroundedBadge } from '../components/CodeGroundedBadge';
import { Spinner } from '../components/Spinner';
import { StatsView } from '../components/insights/StatsView';
import { DecisionPanel } from '../components/DecisionPanel';
import { TaskPanel } from '../components/TaskPanel';
import { IssuePanel } from '../components/IssuePanel';
import { AllComments } from '../components/AllComments';
import { AcPanel } from '../components/AcPanel';
import { ClauseCoveragePanel } from '../components/ClauseCoveragePanel';
import { PhaseTabBar } from '../components/PhaseTabBar';
import { phaseColors } from '../components/phaseColors';
import { useTelemetry } from '../hooks/useTelemetry';
import { TransitionSentence } from '../components/TransitionSentence';
import { DoneSummary } from '../components/DoneSummary';
import { Badge, Tabs } from '../components/ui';
import { DownloadMdDialog } from '../components/DownloadMdDialog';
import { InitPromptDialog } from '../components/InitPromptDialog';
import { useChat } from '../components/ChatContext';
import { useSwitchPosture } from '../hooks/useSwitchPosture';
import { PostureDropdown, HEADER_PILL_CLASS } from '../components/PostureDropdown';
import {
  countUnresolvedDecisions,
  isSpecNarrativeStale,
  HANDOFF_BUTTON_BY_PHASE,
  isQaReportSectionType,
} from '@memex/shared';
import { QaReportCard, selectQaReports } from '../components/QaReportCard';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { COMMENT_PARAM, commentHandle, parseCommentParam } from '../utils/commentDeepLink';
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
import { nextRevealPhase } from '../hooks/useHandholdReveal';
import { useHandholdRevealValue } from '../hooks/HandholdRevealContext';
import { BylineAssignees } from '../components/BylineAssignees';
import { useDocRole } from '../hooks/useDocRole';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOrgScaffoldBlocks } from '../hooks/useOrgScaffoldBlocks';
import { usePresenceHeartbeat } from '../hooks/usePresenceHeartbeat';
import { usePresence } from '../hooks/usePresence';
import { SpecPresenceIndicator } from '../components/pulse/SpecPresenceIndicator';
// spec-362 (dec-1, sol-3): the phase-tab + sub-tab selection state machine and
// the per-sub-tab Narrative view are extracted out of this god-component. The
// SubTab type + defaultSubTabForTab live with the hook now (spec-282 contracts
// preserved verbatim).
import { useDocTabs, type SubTab } from '../hooks/useDocTabs';
import { NarrativeView } from './doc-document/NarrativeView';

export function DocDocument() {
  // spec-64 i-3: the Spec page is also mounted at the canonical Decision / Issue
  // deep-links `specs/:id/decisions/:decId` and `specs/:id/issues/:issueId` (the
  // shape the ⌘K palette navigates to). `id` is the Spec handle; `decId`/`issueId`
  // are the optional sub-targets that open the relevant tab + scroll into view.
  const { id, decId, issueId, namespace, memex } = useParams<{
    id: string;
    decId?: string;
    issueId?: string;
    namespace?: string;
    memex?: string;
  }>();
  const navigate = useNavigate();
  const location = useLocation();
  // spec-178 t-10 (dec-10): the progressive-reveal pointer, scoped to the
  // tenant in the route. Same hook the board uses, so advancing here and the
  // board's filter agree on which demo phase is shown. Tenant comes from the
  // route params (router-driven, unlike window.location); the hook is null-safe.
  const {
    revealedPhase,
    advance: advanceReveal,
    reset: resetReveal,
  } = useHandholdRevealValue(namespace ?? null, memex ?? null);
  // spec-111 t-8: gate every mutation surface on this doc page behind write
  // access to the current Memex. A non-member reading a public Memex sees the
  // full document, decisions, tasks, ACs, and comments — but no edit/create/
  // resolve/status controls. canWrite is threaded into the detail panels +
  // section cards below; the chat panel's read-only posture is handled in
  // DocumentShell.
  const { canWrite } = useMemexAccess(location.pathname);
  const [searchParams, setSearchParams] = useSearchParams();
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
  // spec-100 ac-6 / spec-325 (dec-1): `?comment=c-N` deep-links straight to a
  // comment — but IN SITU, in the narrative, never the flat Comments tab. We land
  // on the narrative sub-tab and hand the seq to the section cards; the owning
  // SectionCard pins the comment on load (emulating a click on its gutter card).
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
  const { track } = useTelemetry(true);
  // spec-362 (dec-1, sol-3): the phase-tab + sub-tab selection state (selectedTab,
  // subTab, selectedSectionId, focusedAcId), the deep-link seeding, and the
  // navigation handlers now live in useDocTabs. It's called below once the doc +
  // sub-tab inventory facts (qaReports) are in hand — before any early return so
  // hook order stays stable.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const [showInitPromptDialog, setShowInitPromptDialog] = useState(false);
  // spec-100: collapse the comment gutters doc-wide (leaving only inline bubbles).
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);

  // spec-118 t-6: resolve the viewer's posture on this Spec. The hook is
  // null-safe before the doc loads and refetches live on 'doc_member' events.
  // `canEdit` is the conjunction of org write access and an editor posture.
  const { myRole, loading: roleLoading } = useDocRole(doc?.id ?? null);
  const canEdit = canWrite && myRole === 'editor';
  // spec-182 dec-1 dissolved the spec-159 ac-19 reviewer fork — every posture
  // renders the same phase block, so no per-posture flag remains here. The
  // posture itself (and the switch between editing/reviewing) lives in the
  // header's PostureDropdown pill (dec-6, amended: the pill is the ONLY
  // switch affordance — no in-page nag).
  // The posture switch behind the header pill — promote/demote + role refetch.
  // Null-safe before the doc loads.
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

  // spec-325 (dec-1): the deep-linked comment is scrolled-to + pinned IN SITU by
  // the owning SectionCard (it receives `deepLinkCommentSeq` and emulates a click
  // on its gutter card). DocDocument no longer scrolls to a flat-tab anchor or
  // selects the Comments tab — that divorced-tab routing is exactly what spec-325
  // removes. (Replaces the old spec-100 scroll-to-`comment-c-{seq}` effect.)

  useEffect(() => {
    if (!id) return;

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
        fetchDocComments(d.id).then(applyComments).catch(console.error);
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
  }, [id, applyComments, navigate]);

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

  // spec-260 (dec-1): qa_report sections are a build OUTPUT, not plan prose —
  // they render through the QaReportCard seats (Verify card / Build sub-tab /
  // Done button) and are excluded from the Specify "Narrative" sub-tab so they
  // never read as frozen plan intent (ac-12).
  const qaReports = selectQaReports(sortedSections);
  const narrativeSections = sortedSections.filter((s) => !isQaReportSectionType(s.sectionType));

  // spec-362 (dec-1, sol-3): the phase-tab + sub-tab selection state machine.
  // Called unconditionally before any early return so hook order stays stable;
  // it reads the loaded doc + the qaReports fact (verify's default landing) and
  // the deep-link hints, and exposes the same handlers/derivations DocDocument
  // used inline. Behaviour is unchanged.
  const tabs = useDocTabs({
    doc,
    hasQaReport: qaReports.length > 0,
    initialCommentSeq,
    initialDecisionHandle,
    initialIssueHandle,
    onScrollToSection: (index) => {
      document.getElementById(`section-${index}`)?.scrollIntoView({ behavior: 'smooth' });
    },
  });
  const {
    setSelectedTab,
    setSubTab,
    selectedSectionId,
    setSelectedSectionId,
    focusedAcId,
    setFocusedAcId,
    viewedTab,
    effectiveSubTab,
    handlePhaseSelect,
    handleSelectSection,
    handleTabChange,
    handleJumpToAc,
    resetAfterTransition,
  } = tabs;

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


  // spec-361: clicking a comment child in the outline opens it IN SITU — set the
  // spec-325 (dec-1) `?comment=c-N` param, then reuse handleSelectSection (which
  // shows the narrative, selects the owning section, and scrolls to it). The
  // owning SectionCard pins its gutter card; never the flat Comments tab.
  const handleSelectComment = useCallback(
    (seq: number, sectionId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(COMMENT_PARAM, commentHandle(seq));
          return next;
        },
        { replace: true },
      );
      handleSelectSection(sectionId);
    },
    [setSearchParams, handleSelectSection],
  );

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

  // spec-164: task cards are read-only agent artifacts — they no longer mount
  // a per-task comment tray, so there is no TaskPanel-driven setter for task
  // comments. The `commentsByTask` state is still populated from the doc load
  // and fed to AllComments (the page-level Comments sub-tab stays readable).

  // spec-136 t-6: fold the picker's resolved full tag set back into the doc
  // payload so chips on the header re-render without a full reloadDoc. The
  // server already returns the doc's complete tag set after each write.
  const handleTagsChange = useCallback((tags: Tag[]) => {
    setDoc((prev) => (prev ? { ...prev, tags } : prev));
  }, []);

  const reloadDoc = useCallback(() => {
    if (!id) return;
    fetchDoc(id).then((d) => {
      setDoc(d);
      fetchDocComments(d.id).then(applyComments).catch(console.error);
      reloadAux(d.id);
    }).catch(console.error);
  }, [id, applyComments, reloadAux]);

  // Refetch when any source (agent, MCP, REST, other clients) mutates this document
  useDocChangeStream(doc?.id ?? null, reloadDoc);

  // spec-122 ac-5 / ac-16: ambient presence on the spec/AC surface. A human
  // VIEWING this spec marks themselves present via the heartbeat (15s while the
  // tab is visible); the presence poll feeds the ambient "● who's working this"
  // indicator on the header + AC tab. Specs only — the presence plane is keyed
  // on spec refs (the endpoint rejects a non-spec ref). The bare handle is an
  // accepted ref form for both endpoints.
  const specRef = doc?.docType === 'spec' ? doc.handle : null;
  usePresenceHeartbeat(specRef);
  const { rows: presentRows } = usePresence(specRef);

  // spec-318 t-11 (ac-17): the Spec page is the ONE page that doesn't use
  // PageHeader, so it sets document.title itself — handle FIRST (`spec-N · name`)
  // so the unique id survives truncation in a narrow desktop tab chip. Other
  // doc types loaded here fall back to the plain doc title. Called before any
  // early return so the hook order stays stable; a null doc yields no title and
  // leaves the current one untouched.
  useDocumentTitle(
    doc?.docType === 'spec'
      ? { kind: 'spec', handle: doc.handle, name: doc.title }
      : { kind: 'page', title: doc?.title ?? '' },
  );

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
            header keeps Share / Download / menu (all on canWrite). The posture
            pill moved OUT of the header into the in-page phase container
            (spec-252 dec-2): it now sits left of the phase bar and scrolls with
            the page. spec-182/dec-6 is preserved — still the only posture
            switch, it just relocated. */}
        {/* spec-409 (ac-1): the code-grounded verification badge lives on the
            byline next to the tags (see below), not in the header. */}
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
            { label: 'Move to another memex', onClick: () => setMoveOpen(true), separatorBefore: true },
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
  }, [doc, reloadDoc, navigate, totalCommentCount, canWrite, canEdit]);

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
  // spec-362 (dec-1): `viewedTab` (the browsed phase view) is derived in
  // useDocTabs from `selectedTab` ?? the doc's current phase — same logic as
  // the old inline `currentTab`/`viewedTab` pair, now lifted into the hook.

  // ── spec-159 ac-17: the next-action handoff line ───────────────────────────
  // Beneath the Rubicon line, a one-sentence "Copy a prompt to …" handoff keyed
  // to the Spec's CURRENT phase (not the browsed tab). It renders for every
  // viewer — copying a prompt is read-only. draft + specify share the specify handoff;
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

  // ── spec-178 t-10 (dec-10): the in-page progressive-reveal advance control ──
  // On a demo spec the page mirrors the board's advance affordance near the
  // value banner. Advancing bumps the shared reveal pointer and navigates back
  // to the board, where the freshly-revealed (next-phase) demo card is now the
  // one shown — the cleaner of the two offered paths (the board is the demo's
  // home; the spec we just walked away from is no longer revealed). At the
  // terminal 'done' phase there is no next: the control becomes "Reset demo",
  // firing the SAME re-seed (resetHandholdDemo) the board's Reset button does
  // plus reset()-ing the pointer to 'draft', then returning to the board.
  const demoNextPhase = doc.isDemo ? nextRevealPhase(revealedPhase) : null;
  const handleDemoAdvance = () => {
    advanceReveal();
    navigate(tenantPath('/specs'));
  };
  const handleDemoResetFromDoc = async () => {
    if (
      !window.confirm(
        'Reset the demo specs? This deletes the current demo specs and re-seeds a fresh set. Your real specs are untouched.',
      )
    ) {
      return;
    }
    try {
      // Tenant comes from the route params (same source the reveal hook keys
      // on), so the re-seed target and the pointer key always agree.
      if (namespace && memex) await resetHandholdDemo(namespace, memex);
      resetReveal();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to reset demo');
      return;
    }
    navigate(tenantPath('/specs'));
  };

  // spec-283 dec-4: the four review-ACTION buttons (Summarise / Security /
  // Design / Architecture) that used to live here have moved into the agent's
  // idle/empty state (ChatPanel) — they're static scaffold prompts that need no
  // page context, so the agent fires them directly. Only the review-HANDOFF
  // line (below) stays on the page, because it interpolates page-level context.

  // spec-203 dec-1: the handoff node id is sourced from the single shared
  // HANDOFF_BUTTON_BY_PHASE map — the SAME map the in-chat footer projection
  // (`toHandoffEssence`) selects through — so the copy button and the footer
  // can never drift on which handoff belongs to a phase. The map also encodes
  // the "draft / done → no handoff" rule (those phases are absent), so an absent
  // id collapses the whole line to null.
  const handoffButtonId = HANDOFF_BUTTON_BY_PHASE[phase];
  const handoff: {
    buttonId: string;
    sentence: React.ReactNode;
    /** The clickable words — they lead the line and name the prompt (issue-4). */
    linkText?: string;
    /** Plain-text FULL sentence for the accessible name (needed when sentence is a node). */
    sentenceLabel?: string;
  } | null =
    !handoffButtonId
      ? null
      :
    // spec-164 issue-1: draft shows NO handoff line. Originally spec-159 ac-17
    // shared the specify handoff between draft and specify (one arm,
    // `phase === 'draft' || phase === 'specify'`). But dec-3 gates the Decisions &
    // ACs panels in draft behind an empty-state directive ("Move this spec to
    // Specify to start capturing Decisions and ACs.") — the draft posture is to
    // invite the move to Specify FIRST. A coding-agent prompt to "create
    // Decisions and ACs" while in draft contradicts that gate-the-invitation
    // principle, so draft now yields null (no handoff); specify keeps the
    // plan-handoff Scaffold node (the BASE_SCAFFOLD PromptButtonNode id is
    // unchanged — it's a stable scaffold id, not a phase value).
    // spec-182 issue-4: the hyperlink LEADS each handoff line and NAMES its
    // prompt ("Copy the Specify prompt …"), so adjacent handoff lines are
    // distinguishable from the blue text alone — the old shape buried the
    // purpose at the end of two near-identical "Copy and paste this prompt…"
    // sentences. Link names match the tab bar's phase display names.
    phase === 'specify'
      ? {
          buttonId: handoffButtonId,
          // "*Copy the Specify prompt* into your coding agent to create
          // **Decisions** and **ACs**, **grounded in the code**." — entities
          // bold. "ACs" stays abbreviated: the Rubicon line above already spells
          // out "Acceptance Criteria (ACs)" in full. spec-409: the grounding tail
          // signals the specify prompt now also drives code-grounding.
          linkText: 'Copy the Specify prompt',
          sentence: (
            <>
              into your coding agent to create{' '}
              <strong className="font-semibold">Decisions</strong> and{' '}
              <strong className="font-semibold">ACs</strong>,{' '}
              <strong className="font-semibold">grounded in the code</strong>.
            </>
          ),
          sentenceLabel:
            'Copy the Specify prompt into your coding agent to create Decisions and ACs, grounded in the code.',
        }
      : phase === 'build'
        ? {
            buttonId: handoffButtonId,
            // "*Copy the Build prompt* into your coding agent to complete
            // the **Tasks** and build this spec."
            linkText: 'Copy the Build prompt',
            sentence: (
              <>
                into your coding agent to complete the{' '}
                <strong className="font-semibold">Tasks</strong> and build this spec.
              </>
            ),
            sentenceLabel:
              'Copy the Build prompt into your coding agent to complete the Tasks and build this spec.',
          }
        : phase === 'verify'
          ? {
              buttonId: handoffButtonId,
              // "*Copy the Verify prompt* into your coding agent to verify
              // this spec against its **ACs**." — "ACs" stays abbreviated: the
              // Rubicon line above already spells out "Acceptance Criteria
              // (ACs)" in full.
              linkText: 'Copy the Verify prompt',
              sentence: (
                <>
                  into your coding agent to verify this spec against its{' '}
                  <strong className="font-semibold">ACs</strong>.
                </>
              ),
              sentenceLabel:
                'Copy the Verify prompt into your coding agent to verify this spec against its ACs.',
            }
          : null; // done → no handoff line

  // Counts feeding the in-situ phase directives — derived from the page's
  // already-fetched AC / task sets plus the shared open-decision count.
  // `hasAcceptanceCriteria` informs specify→build; `openTaskCount` build→verify;
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
  // spec-196 dec-2: the specify→build rubric also gates on narrative freshness.
  // Same shared signal the refresh affordances key on — any decision modified
  // after `narrativeLastConsolidatedAt` means the prose hasn't caught up with
  // the decisions graph yet.
  const narrativeStale = isSpecNarrativeStale(
    doc.narrativeLastConsolidatedAt ?? null,
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
  // that phase's own layout — a directive about specify→build is noise while
  // browsing the build tab from verify.
  const pluralise = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  type DirectivePart = { em: string; rest: string };
  const directiveLine = (parts: DirectivePart[], target: string, tail = '') => {
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
          before this spec can move to {phaseDisplayName(target)}
          {tail}.
        </span>
      </p>
    );
  };
  // spec-196 dec-2: the narrative-staleness condition joins the specify→build
  // axis — but only once every decision is resolved (consolidating while
  // decisions are still open would be premature; the prose chases a moving
  // target). Mirrors the Rubicon line's fragment + how-to tail (dec-3 copy).
  const planNarrativeStale = decs.length > 0 && openDecisionCount === 0 && narrativeStale;
  const planDirective = directiveLine(
    phase === 'specify'
      ? [
          ...(decs.length === 0
            ? [{ em: 'Decisions', rest: 'must be created' }]
            : openDecisionCount > 0
              ? [{ em: pluralise(openDecisionCount, 'Decision'), rest: 'must be resolved' }]
              : []),
          ...(planNarrativeStale
            ? [
                {
                  em: 'The spec narrative',
                  rest: 'must be updated to reflect the resolved decisions',
                },
              ]
            : []),
          ...(!hasAcceptanceCriteria
            ? [{ em: 'Acceptance Criteria (ACs)', rest: 'must be created' }]
            : []),
        ]
      : [],
    'build',
    planNarrativeStale ? ' — use the refresh action to generate the update prompt' : '',
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

  // spec-282 (dec-2): the ONE ordered sub-tab inventory the unified control
  // carries in every phase — Narrative · Comments · Decisions & ACs · Agent
  // Tasks & Issues · QA Report. (Supersedes the disjoint spec-260 per-phase sets:
  // the old `planSubTabs` Narrative/Decisions/Comments AND the Build
  // Tasks&Issues/QA-Report tabs collapse into this single bar.)
  const subTabs = [
    /* spec-233 dec-1 (supersedes spec-196 dec-1): the label reads "Narrative".
       Calling this single tab "Spec" misread as if it WERE the whole spec — the
       whole object is the Spec; this tab is the prose lens within it. The id
       stays 'narrative' — internal vocabulary, deep links and comment routing
       are deliberately unchanged (display-label-only). */
    { id: 'narrative', label: 'Narrative', count: sectionCommentCount, countVariant: 'warning' as const },
    /* spec-282 dec-2: Comments placed second (after Narrative) as a persistent
       companion view, not an end-of-line afterthought. */
    { id: 'comments', label: 'Comments', count: totalCommentCount, countVariant: 'warning' as const },
    { id: 'decisions', label: 'Decisions & ACs', count: decisionCommentCount, countVariant: 'warning' as const },
    /* spec-282 dec-2: "Agent Tasks & Issues" preserves the spec-260 Tasks │
       Issues two-column and names the agent's execution layer explicitly. */
    { id: 'work', label: 'Agent Tasks & Issues' },
    /* spec-282 dec-1: QA Report is present in every phase; before a report
       exists it renders an honest empty-state placeholder (ac-3). */
    { id: 'qa-report', label: 'QA Report', count: qaReports.length || undefined },
    /* spec-406: per-spec Stats — phase-duration timeline, lifecycle charts, and a
       who/what/when activity audit. Persistent across phases like the others. */
    { id: 'stats', label: 'Stats' },
  ];

  // ── Reusable content fragments — each phase layout below composes these ─────
  // spec-362 (dec-1, sol-3): the Narrative sub-tab view is extracted into
  // NarrativeView (sections render eagerly, identical to before). perf-6
  // (virtualization) is deferred — see NarrativeView's header for why the
  // content-visibility approach was backed out.
  const narrativeView = (
    <NarrativeView
      doc={doc}
      narrativeSections={narrativeSections}
      selectedSectionId={selectedSectionId}
      totalCommentCount={totalCommentCount}
      commentCounts={commentCounts}
      commentsBySection={commentsBySection}
      commentsCollapsed={commentsCollapsed}
      canWrite={canWrite}
      canEdit={canEdit}
      onToggleCommentsCollapsed={() => setCommentsCollapsed((v) => !v)}
      onExpandComments={() => setCommentsCollapsed(false)}
      onSectionCommentsChange={handleSectionCommentsChange}
      onSelectSection={setSelectedSectionId}
      deepLinkCommentSeq={initialCommentSeq}
      onOutlineSectionClick={handleSelectSection}
      onOutlineCommentClick={handleSelectComment}
    />
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
      /* spec-178 ac-24: same handle auto-linking suppression for demo decisions. */
      isDemo={doc.isDemo ?? false}
      /* spec-247 dec-4: context for the candidate-review handoff PromptButton
         and the chat-seeded "Ask for more explanation" prompt. */
      promptContext={handoffContext}
      orgBlocks={orgBlocks}
    />
  );

  const acPanel = (
    <div className="space-y-2">
      {/* spec-122 ac-5: the AC-tab presence banner — a heads-up that ACs may
          shift while someone (esp. an agent) is actively working the spec. */}
      {presentRows.length > 0 && (
        <div data-testid="ac-presence-banner">
          <SpecPresenceIndicator present={presentRows} variant="ac" />
        </div>
      )}
      <AcPanel
        docId={doc.id}
        specPhase={phase}
        focusedAcId={focusedAcId}
        onFocusConsumed={() => setFocusedAcId(null)}
        /* spec-247 dec-4: context for the "Wire the AC tests" handoff. */
        promptContext={handoffContext}
        orgBlocks={orgBlocks}
      />
    </div>
  );

  const taskPanel = (
    <TaskPanel
      docId={doc.id}
      doc={doc}
      tasks={ts}
      onUpdate={reloadDoc}
      canWrite={canWrite}
    />
  );

  // spec-188 dec-4: the Build tab offers Convert-to-Task; the Verify tab does
  // NOT — converting mints an incomplete (build-phase) task, so the human
  // verify posture doesn't invite it. Parameterised per layout below.
  const issuePanel = (allowConvert: boolean) => (
    <IssuePanel
      docId={doc.id}
      canWrite={canWrite}
      /* spec-182 dec-4: dispositions (convert / won't-fix) are editor calls;
         registering stays open to reviewers via canWrite. */
      canEdit={canEdit}
      allowConvert={allowConvert}
      onUpdate={reloadDoc}
      highlightIssueHandle={initialIssueHandle}
    />
  );

  // spec-188 dec-5: the Verify tab's compact task-completion echo — the
  // confirmation that everything built is built, and the amber exception
  // signal when verification work has regressed the Spec (incomplete tasks
  // on a verify view). Hidden when the Spec has no tasks.
  const completedTaskCount = ts.filter((t) => t.status === 'complete').length;
  const incompleteTaskCount = ts.length - completedTaskCount;
  const verifyTaskEcho =
    ts.length === 0 ? null : (
      <div
        data-testid="verify-task-echo"
        className={`mb-4 text-xs ${
          incompleteTaskCount === 0
            ? 'text-green-600 dark:text-green-400'
            : 'text-amber-600 dark:text-amber-400'
        }`}
      >
        {incompleteTaskCount === 0
          ? `✓ ${completedTaskCount}/${ts.length} tasks complete`
          : `⚠ ${incompleteTaskCount} of ${ts.length} task${
              ts.length === 1 ? '' : 's'
            } incomplete — this Spec has unbuilt work`}
      </div>
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

  // ── spec-282: ONE persistent sub-tab control for Specify/Build/Verify ──────
  //    (dec-1/dec-2/dec-3, supersedes the spec-159/spec-260 per-phase PHASE_LAYOUTS
  //    map). The control's tab inventory is CONSTANT across phases, so it is never
  //    swapped out as the phase changes (ac-1) and the set never shrinks (ac-2).
  //    `effectiveSubTab` is the explicit selection (`subTab`) when set, else the
  //    current viewed phase's default landing tab (dec-3) — `null` collapses to
  //    Narrative, which only matters for `done` (which renders its own view).
  //    spec-362 (dec-1): derived in useDocTabs (same logic), destructured above.

  const unifiedSubTabView = (
    <>
      {/* Classic underline tabs (full-width baseline + active bar). */}
      <Tabs
        tabs={subTabs}
        activeTab={effectiveSubTab}
        onChange={(t) => {
          // Which parts of a spec people read. Fire only on a real change
          // (the explicit user selection), enum-only props.
          if (t !== effectiveSubTab) {
            track('spec.tab_viewed', { tab: t, phase: viewedTab });
          }
          setSubTab(t as SubTab);
        }}
        variant="underline"
      />
      {effectiveSubTab === 'narrative' && narrativeView}
      {effectiveSubTab === 'comments' && allCommentsView}
      {effectiveSubTab === 'decisions' &&
        // planDirective / verifyDirective are each phase-gated (null off-phase),
        // so at most one renders above the Decisions & ACs two-column.
        twoCol(
          decisionPanel,
          acPanel,
          <>
            {planDirective}
            {verifyDirective}
          </>,
        )}
      {effectiveSubTab === 'work' &&
        // spec-188 dec-4: convert-to-task is a BUILD affordance only (it mints an
        // incomplete build-phase task), gated on the Spec's actual phase, not the
        // viewed tab. The verify-phase task-completion echo only shows in verify.
        twoCol(
          taskPanel,
          issuePanel(phase === 'build'),
          <>
            {buildDirective}
            {/* The verify task-completion echo is a verify-VIEW element (it shows
                whenever the verify tab is browsed, as the old verify layout did),
                so it keys on the viewed tab, not the Spec's actual phase. */}
            {viewedTab === 'verify' && verifyTaskEcho}
          </>,
        )}
      {effectiveSubTab === 'qa-report' && (
        // spec-282 dec-1/ac-3: present in every phase; before a report exists the
        // empty-state names when it's produced. (spec-260 front-loaded it in
        // verify; here it's one tab in the persistent control.)
        <QaReportCard
          reports={qaReports}
          emptyState="No QA report yet — generated when build hands off to verify"
        />
      )}
      {/* spec-406: the per-spec Stats tab, keyed by the spec handle. */}
      {effectiveSubTab === 'stats' && <StatsView specRef={doc.handle} />}
    </>
  );

  // spec-258/dec-3: browsing the Done tab previews the retrospective the move
  // will produce — the same fetch-free DoneSummary, minus Reopen/mutation. Shown
  // while browsing Done before the spec is closed; once the spec is actually
  // `done` the real DoneSummary (with Reopen) takes over the whole area below.
  const doneTabView = (
    <DoneSummary
      doc={doc}
      decisions={decs}
      tasks={ts}
      acs={acs}
      issues={issues}
      people={assignees}
      preview
    />
  );

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
              {/* spec-409 (ac-1): the code-grounded verification badge sits inline
                  with the tags on the byline. Renders only for a grounded Spec
                  (component returns null otherwise), so the separator is gated on
                  groundedInCode to avoid an orphan dot. */}
              {doc.groundedInCode && (
                <>
                  <span className="opacity-40">&middot;</span>
                  <CodeGroundedBadge
                    groundedInCode={doc.groundedInCode}
                    groundedStale={doc.groundedStale ?? false}
                    groundedBy={doc.groundedByName ?? null}
                    groundedAt={doc.groundedAt ? new Date(doc.groundedAt).toLocaleDateString() : null}
                  />
                </>
              )}
              {/* spec-122 ac-5: ambient presence — who's working this spec now. */}
              {presentRows.length > 0 && (
                <>
                  <span className="opacity-40">&middot;</span>
                  <SpecPresenceIndicator present={presentRows} variant="spec" />
                </>
              )}
            </>
          )}
        </div>
        {/* spec-118 t-6: assignment moved onto the byline (spec-159, see above).
            The per-Spec posture (editor/reviewer) switching UI left this page in
            spec-159 — it's handled elsewhere; SpecRoleControls is no longer
            rendered here. */}
      </div>

      {/* spec-178 ac-25/ac-26 (dec-8): the per-phase value banner atop a demo spec.
          The server attaches `demoValueCallout` to the GET payload of an is_demo doc,
          keyed to the doc's current phase. It is DEMO GUIDANCE — a "what this phase is
          for" callout — NOT part of the spec content, so it renders as a distinct
          accent panel above the document body rather than inside a section. Shown only
          when the doc is a demo AND a callout exists for its phase; absent on real
          specs and on demo phases that carry no callout. */}
      {doc.isDemo && doc.demoValueCallout && (
        <div
          data-testid="demo-value-banner"
          className="mb-4 flex items-start gap-2.5 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3"
        >
          <Badge status="demo" label="DEMO" className="flex-none mt-0.5" />
          <p className="text-sm text-primary leading-relaxed">{doc.demoValueCallout}</p>
        </div>
      )}

      {/* spec-178 ac-33/ac-34 (dec-10): the in-page progressive-reveal advance
          control, near the value banner and rendered ONLY on a demo spec. It
          walks the shared reveal pointer and returns to the board (the demo's
          home), where the next-phase demo card is now revealed. At 'done' there
          is no next, so it becomes "Reset demo" — same re-seed + pointer reset
          as the board's Reset button. Absent on real specs. */}
      {doc.isDemo && (
        <div className="mb-4">
          {demoNextPhase ? (
            <button
              type="button"
              data-testid="demo-advance-control"
              onClick={handleDemoAdvance}
              className="text-sm font-medium text-accent hover:text-accent-hover inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-accent/40 bg-accent/10 hover:bg-accent/20 transition-colors"
            >
              See it in {phaseDisplayName(demoNextPhase)} →
            </button>
          ) : (
            <button
              type="button"
              data-testid="demo-reset-control"
              onClick={handleDemoResetFromDoc}
              className="text-sm font-medium text-secondary hover:text-primary inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-edge hover:bg-overlay transition-colors"
            >
              Reset demo
            </button>
          )}
        </div>
      )}

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
          commentCount={totalCommentCount}
          onClose={() => setMoveOpen(false)}
        />
      )}

      {/* spec-182 dec-1: ONE shared phase block for every posture — the
          spec-159 ac-19 reviewer fork is dissolved (a writable reviewer used to
          get a review-action block IN PLACE of the tab bar; that inverted the
          trust gradient — read-only strangers could browse phases, trusted
          reviewers couldn't). The PhaseTabBar browses phase views without ever
          moving the Spec; the TransitionSentence beneath it is the *only* phase
          mutation — one [Yes], no modal, gated on canEdit. Reviewers reach the
          sentence as a status-only line (dec-2); the header posture pill is the
          only switch affordance (dec-6, amended 2026-06-05 — the in-slot nag
          was removed). `done` collapses both into the DoneSummary for everyone. */}
      {doc.docType === 'spec' &&
        phase !== 'done' && (
          <div
            data-testid="phase-container"
            className={`mb-4 rounded-lg p-3 space-y-2 ${phaseColors(phase)?.container ?? ''}`}
          >
            {/* spec-252 dec-2/dec-3: the posture pill sits inside the container,
                left of the phase bar, on a shared row (it moved out of the app
                header). Gated on canWrite — read-only viewers can't switch. */}
            <div className="flex items-center gap-3">
              {canWrite && !roleLoading && (
                <PostureDropdown myRole={myRole} onSelect={(target) => switchPosture(target)} />
              )}
              <PhaseTabBar
                currentPhase={phase}
                selectedTab={viewedTab}
                onSelect={handlePhaseSelect}
              />
            </div>
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
              narrativeStale={narrativeStale}
              onTransitioned={() => {
                // The view follows the move: clear the browsed-tab pin so
                // `viewedTab` falls back to the (re-fetched) current phase's
                // home tab, and reset the sub-tab to that phase's default
                // landing tab (spec-282 dec-3).
                resetAfterTransition();
                reloadDoc();
              }}
              onCancelBrowse={() => setSelectedTab(null)}
            />
            {/* spec-283 dec-4: the four review ACTIONS have moved off the page
                into the agent's idle/empty state (ChatPanel) — the page no
                longer carries the "Review actions" disclosure or the button
                row. What STAYS is the coding-agent review-HANDOFF line: it
                interpolates {namespace}/{memex}/{handle}/{title}/{url} — page
                context the generic agent panel doesn't carry — and serves the
                distinct "conduct the review in your own coding agent" workflow.
                spec-287 dec-2 SUPERSEDES spec-283 dec-4's "ungated, both
                postures" clause: one prompt per posture in Specify. The review
                handoff is now gated to NON-editors (!canEdit) — reviewers and
                read-only viewers — while the editor sees the phase handoff
                below (canEdit) and NOT this line. spec-287 dec-1: the link is
                Title Case ("Copy the Review prompt"), matching the
                Specify/Build/Verify family. spec-182 issue-4: the link leads
                each line and names its prompt. */}
            {phase === 'specify' && !canEdit && (
              <div data-testid="review-handoff-line">
                <PromptButton
                  buttonId="review-handoff"
                  context={handoffContext}
                  orgBlocks={orgBlocks}
                  linkText="Copy the Review prompt"
                  sentence="into your coding agent if you prefer to conduct the review from there."
                  sentenceLabel="Copy the Review prompt into your coding agent if you prefer to conduct the review from there."
                />
              </div>
            )}
            {/* spec-159 ac-17: the next-action handoff line — a "Copy a prompt
                to …" sentence keyed to the CURRENT phase; absent at `done`.
                spec-182 issue-2 amends ac-17's "renders for every viewer":
                the prompt's CONTENT drives state changes and building, so the
                line is an editor affordance — gated on canEdit. The review
                handoff above stays for both postures (dec-3: reviewing is the
                reviewer's own workflow). */}
            {canEdit && handoff && (
              <div data-testid="phase-handoff-line">
                <PromptButton
                  buttonId={handoff.buttonId}
                  context={handoffContext}
                  orgBlocks={orgBlocks}
                  /* spec-282 dec-5(A): the three phase handoffs copy a short
                     get_prompt stub — the coding agent fetches the full prompt
                     itself. The review handoff above is NOT stubbed. */
                  stub
                  sentence={handoff.sentence}
                  linkText={handoff.linkText}
                  sentenceLabel={handoff.sentenceLabel}
                />
              </div>
            )}
          </div>
        )}

      {/* Content area. `done` → the retrospective report replaces it entirely;
          browsing the Done tab (while not yet done) shows its read-only preview;
          every other phase view renders the ONE persistent sub-tab control
          (spec-282). Non-Spec docs (no phase layer) fall back to the Narrative
          view. Every posture browses via the tab bar above (spec-182 dec-1). */}
      {doc.docType === 'spec' && phase === 'done' ? (
        <DoneSummary
          doc={doc}
          decisions={decs}
          tasks={ts}
          acs={acs}
          issues={issues}
          people={assignees}
          /* spec-164 dec-5, relaxed by spec-196: the one deliberate door back
             from done. Gates on org WRITE ACCESS (canWrite), not an editor
             posture — the reviewer/editor distinction is meaningless on a
             closed spec, and the status write here would 403 only for a
             non-member. DoneSummary stays fetch-free (ac-9); after the write
             the view follows the move, like TransitionSentence's onTransitioned. */
          canReopen={canWrite}
          onReopen={async () => {
            await updateDocStatus(doc.id, 'verify');
            setSelectedTab(null);
            reloadDoc();
          }}
        />
      ) : doc.docType !== 'spec' ? (
        <>
          {narrativeView}
          {/* spec-151 t-7: the clause-coverage view (CI-backed green vs local-only)
              hangs off a Standard's page, below its narrative. */}
          {doc.docType === 'standard' && <ClauseCoveragePanel docId={doc.id} />}
        </>
      ) : viewedTab === 'done' ? (
        doneTabView
      ) : (
        unifiedSubTabView
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
