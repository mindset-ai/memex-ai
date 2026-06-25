// spec-361 issue-2 (ac-9) — scroll-spy: scrolling the narrative updates which
// segment is highlighted in the SEGMENTS outline. Driven by an IntersectionObserver
// in DocDocument that watches the `section-${n}` card elements; the topmost one in
// the viewport band becomes active (exposed as aria-current on the outline row).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-361/acs/ac-${n}`;

// Capture IntersectionObserver instances so the test can drive intersections.
type Entry = { target: Element; isIntersecting: boolean; intersectionRatio: number };
const ioInstances: FakeIO[] = [];
class FakeIO {
  cb: (entries: Entry[]) => void;
  elements: Element[] = [];
  // Mirror the real IntersectionObserver signature (callback, options?) so the
  // production `new IntersectionObserver(cb, { rootMargin, threshold })` call
  // type-checks against the stub. Options are irrelevant to the test.
  constructor(cb: (entries: Entry[]) => void, _options?: IntersectionObserverInit) {
    this.cb = cb;
    ioInstances.push(this);
  }
  observe(el: Element) {
    this.elements.push(el);
  }
  unobserve(el: Element) {
    this.elements = this.elements.filter((e) => e !== el);
  }
  disconnect() {
    this.elements = [];
  }
  fire(entries: Entry[]) {
    this.cb(entries);
  }
}

// SectionCard mocked to render the stable `section-${n}` id the scroll-spy keys on.
vi.mock('../components/SectionCard', () => ({
  SectionCard: (props: { sectionNumber: number }) => (
    <div data-testid="section-card" id={`section-${props.sectionNumber}`} />
  ),
}));
vi.mock('../components/AllComments', () => ({ AllComments: () => <div data-testid="all-comments" /> }));
vi.mock('../components/DecisionPanel', () => ({ DecisionPanel: () => <div data-testid="decision-panel" /> }));
vi.mock('../components/AcPanel', () => ({ AcPanel: () => <div data-testid="ac-panel" /> }));
vi.mock('../components/TaskPanel', () => ({ TaskPanel: () => <div data-testid="task-panel" /> }));
vi.mock('../components/IssuePanel', () => ({ IssuePanel: () => <div data-testid="issue-panel" /> }));
// DocOutline is the surface under test — NOT mocked.
vi.mock('../components/TagPicker', () => ({ TagPicker: () => null }));
vi.mock('../components/BylineAssignees', () => ({ BylineAssignees: () => <div data-testid="byline-assignees" /> }));
vi.mock('../components/DoneSummary', () => ({ DoneSummary: () => <div data-testid="done-summary" /> }));

vi.mock('../hooks/useMemexAccess', () => ({ useMemexAccess: () => ({ canWrite: true, isReadOnly: false }) }));
vi.mock('../hooks/useDocRole', () => ({
  useDocRole: () => ({ myRole: 'editor', editors: [], loading: false, refetch: vi.fn() }),
}));
vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('../hooks/useOrgScaffoldBlocks', () => ({ useOrgScaffoldBlocks: () => [] }));

const chat = { setDocId: vi.fn(), setDoc: vi.fn(), setOpenCommentCount: vi.fn(), sendMessage: vi.fn() };
vi.mock('../components/ChatContext', () => ({ useChat: () => chat }));

function makeDoc(): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-361',
    title: 'Scroll-spy',
    docType: 'spec',
    status: 'specify',
    creator: { name: 'Barrie', email: 'barrie@mindset.ai' },
    createdAt: '2026-06-01T00:00:00Z',
    statusChangedAt: '2026-06-04T00:00:00Z',
    narrativeLastConsolidatedAt: null,
    sections: [
      { id: 's-1', seq: 1, title: 'Overview', body: 'x' },
      { id: 's-2', seq: 2, title: 'User Interface', body: 'y' },
    ],
    decisions: [],
    tasks: [],
    tags: [],
  } as unknown as DocWithGraph;
}

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
  promoteToEditor: vi.fn(),
  demoteToReviewer: vi.fn(),
}));

import { DocDocument } from './DocDocument';
import { HeaderSlotProvider, useHeaderSlotContent } from '../components/HeaderSlot';

function HeaderSink() {
  return <div data-testid="header-slot">{useHeaderSlotContent()}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HeaderSlotProvider>
        <HeaderSink />
        <Routes>
          <Route path="/:ns/:mx/specs/:id" element={<DocDocument />} />
        </Routes>
      </HeaderSlotProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ioInstances.length = 0;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    FakeIO as unknown;
});

describe('spec-361 issue-2 — outline scroll-spy', () => {
  it('scrolling a section into view marks its segment active; topmost wins (ac-9)', async () => {
    tagAc(AC(9));
    renderAt('/n/m/specs/spec-361');

    // Outline rendered both segments; nothing is active before any scroll.
    await screen.findByText('User Interface');
    const seg1 = () => screen.getByText('Overview').closest('a') as HTMLElement;
    const seg2 = () => screen.getByText('User Interface').closest('a') as HTMLElement;
    expect(seg1()).not.toHaveAttribute('aria-current');
    expect(seg2()).not.toHaveAttribute('aria-current');

    // The scroll-spy effect wires an IntersectionObserver to the section cards.
    // It runs after commit, so wait for it rather than assuming it's synchronous
    // with the outline render (the assumption flaked under CI's slower run).
    await waitFor(() => expect(ioInstances.length).toBeGreaterThan(0));

    // Scroll so section 2 is the one in the viewport band → segment 2 active.
    // Fire on the CURRENT observer each time: a selection re-render re-arms the
    // effect, creating a fresh observer with an empty `visible` set.
    act(() =>
      ioInstances.at(-1)!.fire([
        { target: document.getElementById('section-2')!, isIntersecting: true, intersectionRatio: 1 },
      ]),
    );
    await waitFor(() => expect(seg2()).toHaveAttribute('aria-current', 'true'));
    expect(seg1()).not.toHaveAttribute('aria-current');

    // Both sections in view at once → the topmost (section 1) wins.
    act(() =>
      ioInstances.at(-1)!.fire([
        { target: document.getElementById('section-1')!, isIntersecting: true, intersectionRatio: 1 },
        { target: document.getElementById('section-2')!, isIntersecting: true, intersectionRatio: 1 },
      ]),
    );
    await waitFor(() => expect(seg1()).toHaveAttribute('aria-current', 'true'));
    expect(seg2()).not.toHaveAttribute('aria-current');
  });
});
