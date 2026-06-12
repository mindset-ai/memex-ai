// spec-258 — the Done tab wired into DocDocument: browsing it previews the
// retrospective (read-only DoneSummary, no Reopen), the Rubicon line above it
// offers the verify→done move through the same browse-and-confirm pattern as
// every other out-of-phase tab, and confirming closes the spec while declining
// returns to the current phase's tab. Mirrors the spec-159 page harness exactly
// (stable, module-level mock identities — unstable per-render mocks like
// `refetch: vi.fn()` feed back through the header slot and loop the page).
//
//   ac-6 : PHASE_LAYOUTS.done renders the read-only DoneSummary preview (fed
//          from on-page props, no Reopen/mutation); selecting Done never mutates.
//   ac-2 : browsing Done offers the browse-confirm Rubicon (ready → "Are you
//          sure…?"; blocked → blocker summary + "Move this spec anyway?").
//   ac-3 : confirming [Yes] → updateDocStatus(doc, 'done'); [No] returns to the
//          current phase's tab without mutating.
//   ac-4 : the Done tab uses resting/selected treatment only — no filled pill.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-258/acs/ac-${n}`;

vi.mock('../components/DecisionPanel', () => ({ DecisionPanel: () => <div data-testid="decision-panel" /> }));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({ IssuePanel: () => <div data-testid="issue-panel" /> }));
vi.mock('../components/AllComments', () => ({ AllComments: () => <div data-testid="all-comments" /> }));
vi.mock('../components/SectionCard', () => ({ SectionCard: () => <div data-testid="section-card" /> }));
vi.mock('../components/DocOutline', () => ({ DocOutline: () => <div data-testid="doc-outline" /> }));
vi.mock('../components/TagPicker', () => ({ TagPicker: () => null }));
vi.mock('../components/BylineAssignees', () => ({ BylineAssignees: () => <div data-testid="byline-assignees" /> }));
// The DoneSummary stub surfaces whether DocDocument handed it the Reopen wiring
// (canReopen) and how many ACs it was fed — so we can prove the Done-tab PREVIEW
// is the read-only, on-page-fed variant (no Reopen), distinct from the post-close
// report which DOES carry Reopen.
vi.mock('../components/DoneSummary', () => ({
  DoneSummary: (props: { canReopen?: boolean; onReopen?: () => void; acs?: unknown[] }) => (
    <div
      data-testid="done-summary"
      data-can-reopen={props.canReopen ? 'true' : 'false'}
      data-acs-count={(props.acs ?? []).length}
    >
      {props.canReopen && (
        <button data-testid="stub-reopen" onClick={() => props.onReopen?.()}>
          reopen
        </button>
      )}
    </div>
  ),
}));

// Stable module-level mock identities (mirrors spec-159) — a fresh function per
// render here (e.g. refetch: vi.fn()) destabilises switchPosture → headerActions
// → the header slot effect, looping the page.
const refetchRole = vi.fn();
vi.mock('../hooks/useMemexAccess', () => ({ useMemexAccess: () => ({ canWrite: true, isReadOnly: false }) }));
vi.mock('../hooks/useDocRole', () => ({
  useDocRole: () => ({ myRole: 'editor', editors: [], loading: false, refetch: refetchRole }),
}));
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('../hooks/useOrgScaffoldBlocks', () => ({ useOrgScaffoldBlocks: () => [] }));
const chat = { setDocId: vi.fn(), setDoc: vi.fn(), setOpenCommentCount: vi.fn(), sendMessage: vi.fn() };
vi.mock('../components/ChatContext', () => ({ useChat: () => chat }));

const updateDocStatus = vi.fn();
const promoteToEditor = vi.fn();
const demoteToReviewer = vi.fn();
let docStatus: DocWithGraph['status'] = 'verify';
let docAcs: unknown[] = [];

function makeDoc(): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-258',
    title: 'Done tab',
    docType: 'spec',
    status: docStatus,
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-10T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    sections: [{ id: 's-1', seq: 1, title: 'Intro', body: 'x' }],
    decisions: [],
    tasks: [{ id: 't-1', status: 'complete' }],
    tags: [],
  } as unknown as DocWithGraph;
}

vi.mock('../api/client', () => ({
  NotFoundError: class NotFoundError extends Error {},
  fetchDoc: () => Promise.resolve(makeDoc()),
  fetchDocComments: () => Promise.resolve({ sections: [], decisions: [], tasks: [] }),
  fetchAcsForBrief: () => Promise.resolve(docAcs),
  fetchIssues: () => Promise.resolve([]),
  fetchDocAssignees: () => Promise.resolve([]),
  archiveDoc: vi.fn(),
  pauseDoc: vi.fn(),
  unpauseDoc: vi.fn(),
  updateDocStatus: (...a: unknown[]) => updateDocStatus(...a),
  promoteToEditor: (...a: unknown[]) => promoteToEditor(...a),
  demoteToReviewer: (...a: unknown[]) => demoteToReviewer(...a),
}));

import { DocDocument } from './DocDocument';
import { HeaderSlotProvider, useHeaderSlotContent } from '../components/HeaderSlot';

function HeaderSink() {
  return <div data-testid="header-slot">{useHeaderSlotContent()}</div>;
}

function renderAt(status: DocWithGraph['status']) {
  docStatus = status;
  return render(
    <MemoryRouter initialEntries={['/n/m/specs/spec-258']}>
      <HeaderSlotProvider>
        <HeaderSink />
        <Routes>
          <Route path="/:ns/:mx/specs/:id" element={<DocDocument />} />
        </Routes>
      </HeaderSlotProvider>
    </MemoryRouter>,
  );
}

function phaseTab(name: string) {
  return screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab') === name)!;
}

// An active AC: verified → clean verify rubric; untested → blocked verify rubric.
const activeAc = (state: 'verified' | 'untested') => ({ ac: { status: 'active' }, verificationState: state });

beforeEach(() => {
  vi.clearAllMocks();
  updateDocStatus.mockResolvedValue(undefined);
  promoteToEditor.mockResolvedValue(undefined);
  demoteToReviewer.mockResolvedValue(undefined);
  docAcs = [activeAc('verified')];
});

describe('spec-258 — Done tab in DocDocument', () => {
  it('browsing Done renders the read-only DoneSummary preview (no Reopen) fed from on-page ACs; selecting it never mutates (ac-6, ac-4)', async () => {
    tagAc(AC(6));
    tagAc(AC(4));
    const user = userEvent.setup();
    renderAt('verify');

    // Verify content shows first (current phase). No preview yet.
    await screen.findByTestId('ac-panel');
    expect(screen.queryByTestId('done-summary')).not.toBeInTheDocument();

    await user.click(phaseTab('done'));

    // The preview renders — and it is the READ-ONLY variant: no Reopen wiring,
    // fed from the page's already-fetched ACs (1 active AC).
    const preview = await screen.findByTestId('done-summary');
    expect(preview).toHaveAttribute('data-can-reopen', 'false');
    expect(preview).toHaveAttribute('data-acs-count', '1');
    expect(screen.queryByTestId('stub-reopen')).not.toBeInTheDocument();

    // dec-4: the Done tab is never the filled "current" pill.
    expect(phaseTab('done')).not.toHaveAttribute('data-current');

    // Browsing is not a mutation.
    expect(updateDocStatus).not.toHaveBeenCalled();
  });

  it('browsing Done with a clean rubric offers "Are you sure you want to move this spec to Done?" + Yes/No (ac-2)', async () => {
    tagAc(AC(2));
    const user = userEvent.setup();
    docAcs = [activeAc('verified')];
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    await user.click(phaseTab('done'));

    const sentence = await screen.findByTestId('transition-sentence');
    await waitFor(() =>
      expect(sentence.textContent).toContain('Are you sure you want to move this spec to Done?'),
    );
    expect(within(sentence).getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    expect(within(sentence).getByRole('button', { name: 'No' })).toBeInTheDocument();
  });

  it('browsing Done with an unverified AC shows the blocker + "Move this spec anyway?" (ac-2)', async () => {
    tagAc(AC(2));
    const user = userEvent.setup();
    docAcs = [activeAc('untested')];
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    await user.click(phaseTab('done'));

    const sentence = await screen.findByTestId('transition-sentence');
    await waitFor(() =>
      expect(sentence.textContent).toContain(
        '1 Acceptance Criterion (AC) must be verified before Done.',
      ),
    );
    expect(sentence.textContent).toContain('Move this spec anyway?');
    expect(within(sentence).getByRole('button', { name: 'Yes' })).toBeInTheDocument();
  });

  it('confirming [Yes] from the Done tab calls updateDocStatus(doc, "done") (ac-3)', async () => {
    tagAc(AC(3));
    const user = userEvent.setup();
    docAcs = [activeAc('verified')];
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    await user.click(phaseTab('done'));
    const sentence = await screen.findByTestId('transition-sentence');
    await waitFor(() =>
      expect(sentence.textContent).toContain('Are you sure you want to move this spec to Done?'),
    );

    await user.click(within(sentence).getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(updateDocStatus).toHaveBeenCalledWith('doc-uuid', 'done'));
  });

  it('declining [No] from the Done tab returns to the current phase tab without mutating (ac-3)', async () => {
    tagAc(AC(3));
    const user = userEvent.setup();
    docAcs = [activeAc('verified')];
    renderAt('verify');

    await screen.findByTestId('ac-panel');
    await user.click(phaseTab('done'));
    const sentence = await screen.findByTestId('transition-sentence');
    await waitFor(() =>
      expect(sentence.textContent).toContain('Are you sure you want to move this spec to Done?'),
    );

    await user.click(within(sentence).getByRole('button', { name: 'No' }));

    // View snaps back to the current phase (verify): the AC panel returns and the
    // Done preview is gone. Phase never changed.
    await screen.findByTestId('ac-panel');
    expect(screen.queryByTestId('done-summary')).not.toBeInTheDocument();
    expect(updateDocStatus).not.toHaveBeenCalled();
  });
});
