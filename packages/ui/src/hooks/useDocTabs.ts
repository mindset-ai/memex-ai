import { useCallback, useEffect, useRef, useState } from 'react';
import type { PhaseTab } from '../components/PhaseTabBar';
import type { DocWithGraph, SpecStatus } from '../api/types';

// spec-362 (dec-1, sol-3): the phase-tab + sub-tab selection state machine,
// lifted verbatim out of DocDocument's body so the page becomes a thinner
// orchestrating container. This hook owns ONLY navigation/selection state —
// which phase view is browsed (`selectedTab`), which sub-tab is shown
// (`subTab`), the in-narrative selected section, and the cross-view AC focus —
// plus the deep-link seeding and the small handlers that move between them. It
// holds no data fetching and no side effects beyond the two deep-link landings
// that already lived in DocDocument; behaviour is unchanged.

// spec-282 (dec-1/dec-2): the SINGLE, ordered inventory of sub-tabs the unified
// control carries in EVERY phase (Narrative · Comments · Decisions & ACs · Agent
// Tasks & Issues · QA Report).
export type SubTab = 'narrative' | 'comments' | 'decisions' | 'work' | 'qa-report' | 'stats';

// spec-282 (dec-3): each phase's preferred LANDING sub-tab. Selecting any other
// tab is always free — this is only the default applied when the user navigates
// to a phase. Verify prefers the QA Report (what a cold verifier reads first),
// falling back to Decisions & ACs when no report exists yet. `done` has no
// sub-tab control (it renders the DoneSummary), so it returns null.
export function defaultSubTabForTab(tab: PhaseTab, hasQaReport: boolean): SubTab | null {
  switch (tab) {
    case 'specify':
      return 'narrative';
    case 'build':
      return 'decisions';
    case 'verify':
      return hasQaReport ? 'qa-report' : 'decisions';
    case 'done':
    default:
      return null;
  }
}

interface UseDocTabsArgs {
  /** The Spec page's loaded doc (null until it loads). */
  doc: DocWithGraph | null;
  /** Whether the current sub-tab inventory has a QA report (drives the verify default landing). */
  hasQaReport: boolean;
  /** Deep-link hints, sourced from the route/query in DocDocument. */
  initialCommentSeq: number | null;
  initialDecisionHandle: string | null;
  initialIssueHandle: string | null;
  /** Smooth-scroll a narrative section into view by its 1-based index. */
  onScrollToSection: (index: number) => void;
}

export interface UseDocTabs {
  selectedTab: PhaseTab | null;
  setSelectedTab: (tab: PhaseTab | null) => void;
  subTab: SubTab | null;
  setSubTab: (tab: SubTab | null) => void;
  selectedSectionId: string | null;
  setSelectedSectionId: (id: string | null) => void;
  focusedAcId: string | null;
  setFocusedAcId: (id: string | null) => void;
  /** The phase view the user is browsing (selection, else the doc's current phase). */
  viewedTab: PhaseTab;
  /** The effective sub-tab once defaults are applied. */
  effectiveSubTab: SubTab;
  /** Phase navigation: landing on a phase resets the explicit sub-tab to its default. */
  handlePhaseSelect: (tab: PhaseTab) => void;
  /** Narrative landing used by the outline / comments-tab navigation. */
  handleSelectSection: (sectionId: string) => void;
  /** AllComments' onTabChange → route section/decision targets under Specify. */
  handleTabChange: (tab: string) => void;
  /** DecisionAcStrip pill → focus the AC under the Decisions & ACs sub-tab. */
  handleJumpToAc: (acId: string) => void;
  /** A phase transition landed: clear the browsed-tab + sub-tab pins. */
  resetAfterTransition: () => void;
}

export function useDocTabs({
  doc,
  hasQaReport,
  initialCommentSeq,
  initialDecisionHandle,
  initialIssueHandle,
  onScrollToSection,
}: UseDocTabsArgs): UseDocTabs {
  // spec-159 t-6: the phase view the user is browsing — it never drives the
  // Spec's phase (that's TransitionSentence's [Yes]); it only changes what's
  // shown. `null` defers to the doc's current phase, computed once it loads.
  const [selectedTab, setSelectedTab] = useState<PhaseTab | null>(null);
  // spec-282 (dec-1/dec-2/dec-3): ONE sub-tab state that persists across
  // Specify/Build/Verify. `null` means "use the current phase's default landing
  // tab"; an explicit selection is respected until the next phase navigation
  // resets it to null. A deep-link sets the relevant landing tab up front.
  const [subTab, setSubTab] = useState<SubTab | null>(
    // spec-325 (dec-1): a comment deep-link lands on the NARRATIVE (where the
    // section's in-context gutter lives), NOT the flat 'comments' tab.
    initialCommentSeq != null
      ? 'narrative'
      : initialDecisionHandle
        ? 'decisions'
        : initialIssueHandle
          ? 'work'
          : null,
  );
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  // Cross-view nav for the DecisionAcStrip pills.
  const [focusedAcId, setFocusedAcId] = useState<string | null>(null);

  // spec-158 ac-17 / ac-4 / ac-11: an issue deep-link must land on a phase view
  // that actually renders IssuePanel. Build / Verify already do; only Specify
  // (draft/specify) and the done report need redirecting to Build once. Runs a
  // single time on the first doc load.
  const issueDeepLinkLandedRef = useRef(false);
  useEffect(() => {
    if (issueDeepLinkLandedRef.current) return;
    if (!doc || !initialIssueHandle) return;
    issueDeepLinkLandedRef.current = true;
    const phaseTab =
      doc.status === 'build' ? 'build' : doc.status === 'verify' ? 'verify' : null;
    if (phaseTab === null) setSelectedTab('build');
  }, [doc, initialIssueHandle]);

  // The tab the phase makes "current" (draft → specify; done → none). The view
  // the user is *browsing* is `selectedTab` once they've clicked, else this.
  const phase = (doc?.status as SpecStatus) ?? 'specify';
  const currentTab: PhaseTab | null =
    phase === 'draft' || phase === 'specify'
      ? 'specify'
      : phase === 'build'
        ? 'build'
        : phase === 'verify'
          ? 'verify'
          : null;
  const viewedTab: PhaseTab = selectedTab ?? currentTab ?? 'specify';

  // spec-282 (dec-1/dec-2/dec-3): `effectiveSubTab` is the explicit selection
  // when set, else the current viewed phase's default landing tab — `null`
  // collapses to Narrative (which only matters for `done`, which renders its
  // own view).
  const effectiveSubTab: SubTab =
    subTab ?? defaultSubTabForTab(viewedTab, hasQaReport) ?? 'narrative';

  const handlePhaseSelect = useCallback((tab: PhaseTab) => {
    // spec-282 dec-3: landing on a phase applies that phase's default sub-tab —
    // reset the explicit selection to null so `effectiveSubTab` falls back.
    setSelectedTab(tab);
    setSubTab(null);
  }, []);

  const handleSelectSection = useCallback(
    (sectionId: string) => {
      // The Narrative lives under the Specify view's first sub-tab.
      setSelectedTab('specify');
      setSubTab('narrative');
      setSelectedSectionId(sectionId);
      const sections = doc ? [...doc.sections].sort((a, b) => a.seq - b.seq) : [];
      const index = sections.findIndex((s) => s.id === sectionId);
      if (index >= 0) {
        setTimeout(() => onScrollToSection(index + 1), 0);
      }
    },
    [doc, onScrollToSection],
  );

  // AllComments' onTabChange hands back a section/decision/task target tab. The
  // only navigable destinations live under the Specify view, so route them
  // there (Narrative for sections, Decisions & ACs for decisions).
  const handleTabChange = useCallback((tab: string) => {
    setSelectedTab('specify');
    if (tab === 'decisions') setSubTab('decisions');
    else if (tab === 'document') setSubTab('narrative');
  }, []);

  const handleJumpToAc = useCallback((acId: string) => {
    setFocusedAcId(acId);
    setSelectedTab('specify');
    setSubTab('decisions');
  }, []);

  const resetAfterTransition = useCallback(() => {
    setSelectedTab(null);
    setSubTab(null);
  }, []);

  return {
    selectedTab,
    setSelectedTab,
    subTab,
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
  };
}
