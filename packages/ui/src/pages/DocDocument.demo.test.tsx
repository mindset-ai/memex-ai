// spec-178 (A-UI, t-7): the per-phase value banner atop a demo spec.
//   ac-25: when a doc is a demo AND carries a demoValueCallout, the banner renders
//          the callout text at the top of the document view.
//   ac-26: the banner is visually DISTINCT from the spec content — it sits outside
//          the section/decision panels (it is demo guidance, not part of the spec)
//          and carries the DEMO marker.
//   ac-11: a real (non-demo) spec renders NO banner; a demo spec whose phase has no
//          callout renders no banner either.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const SPEC_178 = 'mindset-prod/memex-building-itself/specs/spec-178';
const AC = (n: number) => `${SPEC_178}/acs/ac-${n}`;

// Heavy children → identity markers.
vi.mock('../components/DecisionPanel', () => ({ DecisionPanel: () => <div data-testid="decision-panel" /> }));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({ IssuePanel: () => <div data-testid="issue-panel" /> }));
vi.mock('../components/AllComments', () => ({ AllComments: () => <div data-testid="all-comments" /> }));
vi.mock('../components/SectionCard', () => ({
  SectionCard: () => <div data-testid="section-card">section content</div>,
}));
vi.mock('../components/DocOutline', () => ({ DocOutline: () => <div data-testid="doc-outline" /> }));
vi.mock('../components/TagPicker', () => ({ TagPicker: () => null }));
vi.mock('../components/BylineAssignees', () => ({ BylineAssignees: () => <div data-testid="byline-assignees" /> }));
vi.mock('../components/DoneSummary', () => ({ DoneSummary: () => <div data-testid="done-summary" /> }));

vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: true, isReadOnly: false }),
}));
// IMPORTANT: return a STABLE object. DocDocument's `useSwitchPosture` memoises on
// `refetch`, and that feeds the `headerActions` useMemo → `useHeaderSlot` effect.
// A fresh `refetch` (or result object) every render makes `headerActions` a new
// node each render, so the header-slot setContent effect fires on every render —
// once any post-mount re-render occurs (e.g. the reveal pointer bumps), that
// becomes an infinite render loop. A hoisted singleton keeps the chain stable.
const { docRoleResult } = vi.hoisted(() => ({
  docRoleResult: { myRole: 'editor', editors: [], loading: false, refetch: () => {} },
}));
vi.mock('../hooks/useDocRole', () => ({
  useDocRole: () => docRoleResult,
}));
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('../hooks/useOrgScaffoldBlocks', () => ({ useOrgScaffoldBlocks: () => [] }));
vi.mock('../components/ChatContext', () => ({
  useChat: () => ({ setDocId: vi.fn(), setDoc: vi.fn(), setOpenCommentCount: vi.fn(), sendMessage: vi.fn() }),
}));

let docIsDemo = false;
let docValueCallout: string | undefined;
let docStatus: DocWithGraph['status'] = 'specify';

function makeDoc(): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-1',
    title: 'In-app Memex search (⌘K)',
    docType: 'spec',
    status: docStatus,
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    isDemo: docIsDemo,
    demoValueCallout: docValueCallout,
    sections: [{ id: 's-1', seq: 1, sectionType: 'overview', title: 'Overview', content: 'x', createdAt: '', updatedAt: '' }],
    decisions: [],
    tasks: [],
    tags: [],
  } as unknown as DocWithGraph;
}

const resetHandholdDemoMock = vi.fn();
vi.mock('../api/client', () => ({
  NotFoundError: class NotFoundError extends Error {},
  fetchDoc: () => Promise.resolve(makeDoc()),
  fetchDocComments: () => Promise.resolve({ sections: [], decisions: [], tasks: [] }),
  fetchAcsForBrief: () => Promise.resolve([]),
  fetchIssues: () => Promise.resolve([]),
  fetchDocAssignees: () => Promise.resolve([]),
  archiveDoc: vi.fn(),
  pauseDoc: vi.fn(),
  unpauseDoc: vi.fn(),
  updateDocStatus: vi.fn(),
  resetHandholdDemo: (...args: unknown[]) => resetHandholdDemoMock(...args),
  promoteToEditor: vi.fn(),
  demoteToReviewer: vi.fn(),
}));

import { DocDocument } from './DocDocument';
import { HeaderSlotProvider, useHeaderSlotContent } from '../components/HeaderSlot';

function HeaderSink() {
  return <div data-testid="header-slot">{useHeaderSlotContent()}</div>;
}

function renderDoc() {
  return render(
    <MemoryRouter initialEntries={['/alice/personal/specs/spec-1']}>
      <HeaderSlotProvider>
        <HeaderSink />
        <Routes>
          {/* Production param names — the reveal hook reads :namespace / :memex. */}
          <Route path="/:namespace/:memex/specs/:id" element={<DocDocument />} />
          {/* Landing target after an in-page advance / reset. A catch-all so it
              matches wherever the board navigate resolves (tenantPath() depends
              on window.location, which MemoryRouter doesn't drive). */}
          <Route path="*" element={<div data-testid="board-landing">board</div>} />
        </Routes>
      </HeaderSlotProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  docIsDemo = false;
  docValueCallout = undefined;
  docStatus = 'specify';
  // Reset the per-tenant reveal pointer between tests.
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom always has storage; guard anyway */
  }
});

const REVEAL_KEY = 'handhold-reveal:alice/personal';

describe('DocDocument demo value banner (spec-178)', () => {
  it('ac-25/ac-26: a demo spec renders the per-phase value callout as a distinct banner', async () => {
    tagAc(AC(25));
    tagAc(AC(26));
    docIsDemo = true;
    docValueCallout = 'In Specify you lock the decisions before any code is written.';
    renderDoc();

    const banner = await screen.findByTestId('demo-value-banner');
    expect(banner).toHaveTextContent(docValueCallout!);
    // It carries the DEMO marker (guidance, not spec content).
    expect(within(banner).getByText('DEMO')).toBeInTheDocument();
    // ac-26: distinct from the spec content — the banner is NOT inside any
    // section card; the callout text does not appear within section content.
    const sectionCard = screen.getByTestId('section-card');
    expect(sectionCard).not.toContainElement(banner);
    expect(sectionCard).not.toHaveTextContent(docValueCallout!);
  });

  it('ac-11: a real (non-demo) spec renders NO value banner', async () => {
    tagAc(AC(11));
    docIsDemo = false;
    docValueCallout = 'should never show because not a demo';
    renderDoc();

    await screen.findByTestId('section-card');
    expect(screen.queryByTestId('demo-value-banner')).not.toBeInTheDocument();
  });

  it('ac-11: a demo spec with no callout for its phase renders NO banner', async () => {
    tagAc(AC(11));
    docIsDemo = true;
    docValueCallout = undefined; // e.g. a phase that carries no valueCallout
    renderDoc();

    await screen.findByTestId('section-card');
    expect(screen.queryByTestId('demo-value-banner')).not.toBeInTheDocument();
  });
});

describe('DocDocument in-page reveal advance control (spec-178)', () => {
  it('ac-33/ac-34: a demo spec renders an advance control near the banner; a real spec does not', async () => {
    tagAc(AC(33));
    tagAc(AC(34));
    docIsDemo = true;
    docValueCallout = 'Specify locks the decisions before any code is written.';
    renderDoc();

    // The control is present on the demo spec, offering the next phase. Default
    // pointer is 'draft', so next is 'specify' → "Specify".
    const advance = await screen.findByTestId('demo-advance-control');
    expect(advance).toHaveTextContent('Specify');
  });

  it('ac-34: a real (non-demo) spec renders NO advance control', async () => {
    tagAc(AC(34));
    docIsDemo = false;
    renderDoc();

    await screen.findByTestId('section-card');
    expect(screen.queryByTestId('demo-advance-control')).not.toBeInTheDocument();
    expect(screen.queryByTestId('demo-reset-control')).not.toBeInTheDocument();
  });

  it('ac-33/ac-34: advancing bumps the pointer and navigates back to the board', async () => {
    tagAc(AC(33));
    tagAc(AC(34));
    docIsDemo = true;
    // Pointer at 'draft' (default) → advance bumps it to 'specify'.
    renderDoc();

    // fireEvent (not userEvent): the click navigates away, unmounting the
    // clicked node mid-interaction — userEvent's pointer/timer machinery spins
    // on the detached element. A plain synchronous click is the right tool here.
    fireEvent.click(await screen.findByTestId('demo-advance-control'));

    // Pointer bumped + navigated to the board.
    await screen.findByTestId('board-landing');
    expect(window.localStorage.getItem(REVEAL_KEY)).toBe('specify');
  });

  it('ac-34: at the done phase the control is Reset — re-seeds, clears the pointer, returns to the board', async () => {
    tagAc(AC(34));
    docIsDemo = true;
    resetHandholdDemoMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Pointer at the terminal 'done' phase → no next, so the control is Reset.
    window.localStorage.setItem(REVEAL_KEY, 'done');
    renderDoc();

    const reset = await screen.findByTestId('demo-reset-control');
    expect(screen.queryByTestId('demo-advance-control')).not.toBeInTheDocument();

    // fireEvent: the handler navigates away, unmounting the button — same
    // detached-node hazard for userEvent as the advance test above.
    fireEvent.click(reset);

    await waitFor(() => expect(resetHandholdDemoMock).toHaveBeenCalledWith('alice', 'personal'));
    // Pointer cleared back to draft, then navigated to the board.
    await waitFor(() => expect(window.localStorage.getItem(REVEAL_KEY)).toBe('draft'));
    await screen.findByTestId('board-landing');
    confirmSpy.mockRestore();
  });
});
