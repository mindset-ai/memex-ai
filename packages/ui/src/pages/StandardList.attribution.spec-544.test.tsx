// spec-544 dec-5 — repo attribution is VISIBLE on the Standards surface, and
// read-only.
//
// Why this is a mounting test and not a source scan: ac-18/19/21 are claims about
// what a person SEES, and the sibling introspection tests in this repo are for
// structural commitments (prose in the Scaffold, a button wired by id). A claim
// about the rendered surface is verified by rendering it.
//
// WHY THE MARKER FOR AN UNATTRIBUTED STANDARD MATTERS (ac-21). dec-2 makes
// filtering fail open: a Standard with no attribution appears in EVERY repo's
// index. So absence is meaningful — but it means something different from a
// Standard deliberately tagged for both repos. Rendering zero chips would
// collapse "nobody has classified this yet" and "this genuinely spans both" into
// one indistinguishable blank, which is this Spec's own disease one level down:
// metadata that governs what an agent reads, invisible to the person looking
// straight at it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { StandardList } from './StandardList';
import type { DocSummary, Tag } from '../api/types';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-544/acs/ac-${n}`;

vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('../components/StandardsMap', () => ({
  StandardsMap: () => <div data-testid="mock-standards-map" />,
}));
const fetchDocsMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
}));
vi.mock('../components/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('../components/chat/OpeningStandardsController', () => ({
  OpeningStandardsController: () => null,
}));
vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));

/** A flat attribution tag, as dec-1 stores it: scope NULL, value = repo name. */
const repoTag = (value: string): Tag =>
  ({ id: `tag-${value}`, memexId: 'mx-1', scope: null, value }) as Tag;

function standard(overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    id: 'b-1',
    handle: 'std-100',
    title: 'Untitled standard',
    docType: 'standard',
    status: 'approved',
    parentDocId: null,
    createdAt: '2025-01-01T00:00:00Z',
    statusChangedAt: '2025-01-01T00:00:00Z',
    sectionCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

const mount = () =>
  render(
    <MemoryRouter>
      <StandardList />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('spec-544: attribution is visible on the Standards list (ac-18)', () => {
  it('asks for tags in the SAME request as the drift counts', async () => {
    tagAc(AC(18));
    fetchDocsMock.mockResolvedValueOnce([]);

    mount();
    await screen.findByText(/No standards yet/i);

    // Additive to the existing opt-in, not a second round-trip: `include` is one
    // query on the same list route, so attribution costs no extra request.
    expect(fetchDocsMock).toHaveBeenCalledWith('standard', {
      include: ['driftCount', 'tags'],
    });
    expect(fetchDocsMock, 'still ONE call — the N+1 fan-out stays gone').toHaveBeenCalledTimes(1);
  });

  it('renders one chip per attribution tag', async () => {
    tagAc(AC(18));
    fetchDocsMock.mockResolvedValueOnce([
      standard({
        id: 'b-1',
        handle: 'std-44',
        title: 'Flutter clients run through fvm',
        tags: [repoTag('memex-clients')],
      }),
    ]);

    mount();

    expect(await screen.findByText('Flutter clients run through fvm')).toBeInTheDocument();
    expect(
      screen.getByText('memex-clients'),
      'a Standard attributed to memex-clients must SAY so on the card — otherwise the ' +
        'attribution silently governs which index lists it while being invisible here.',
    ).toBeInTheDocument();
  });

  it('renders BOTH chips for a Standard that binds both repos', async () => {
    tagAc(AC(18));
    fetchDocsMock.mockResolvedValueOnce([
      standard({
        id: 'b-1',
        handle: 'std-51',
        title: 'Module shape',
        tags: [repoTag('memex-ai'), repoTag('memex-clients')],
      }),
    ]);

    mount();
    await screen.findByText('Module shape');

    // The set case a scoped `repo::` tag could not express (dec-1).
    expect(screen.getByText('memex-ai')).toBeInTheDocument();
    expect(screen.getByText('memex-clients')).toBeInTheDocument();
    expect(screen.getAllByTestId('tag-chip')).toHaveLength(2);
  });
});

describe('spec-544: an unattributed Standard is visibly unattributed (ac-21)', () => {
  it('renders a marker, not zero chips', async () => {
    tagAc(AC(21));
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', handle: 'std-52', title: 'Nobody has classified me', tags: [] }),
    ]);

    mount();
    await screen.findByText('Nobody has classified me');

    expect(screen.queryAllByTestId('tag-chip')).toHaveLength(0);
    expect(
      screen.getByTestId('standard-unattributed'),
      'Zero chips is indistinguishable from "deliberately both". Under fail-open the ' +
        'absence of attribution is load-bearing, so it gets its own visible state.',
    ).toBeInTheDocument();
  });

  it('renders NO marker once a Standard is attributed', async () => {
    tagAc(AC(21));
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', tags: [repoTag('memex-ai')] }),
    ]);

    mount();
    await screen.findByTestId('tag-chip');

    expect(
      screen.queryByTestId('standard-unattributed'),
      'A classified Standard must not also read as unclassified.',
    ).not.toBeInTheDocument();
  });

  it('treats an absent tags field the same as an empty one', async () => {
    tagAc(AC(21));
    // A caller that forgets `include: ['tags']` gets rows with NO tags key at all.
    // That must read as unattributed, never crash and never look attributed.
    fetchDocsMock.mockResolvedValueOnce([standard({ id: 'b-1', title: 'No tags key' })]);

    mount();
    await screen.findByText('No tags key');
    expect(screen.getByTestId('standard-unattributed')).toBeInTheDocument();
  });
});

describe('spec-544: the attribution shown here is READ-ONLY (ac-19)', () => {
  it('offers no remove affordance on any chip', async () => {
    tagAc(AC(19));
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', tags: [repoTag('memex-ai'), repoTag('memex-clients')] }),
    ]);

    mount();
    await screen.findAllByTestId('tag-chip');

    // std-34 cl-5: writing attribution lives MCP-side, so the web surface renders
    // the state read-only plus a handoff — never an interactive control whose
    // input is silently dropped. cl-9 records the spec-93 failure this prevents:
    // candidate-decision radios that discarded their pick on Approve.
    for (const chip of screen.getAllByTestId('tag-chip')) {
      expect(
        chip.querySelector('button'),
        'A × on this chip would promise a write this surface cannot perform.',
      ).toBeNull();
    }
  });

  it('renders no tag input or picker on the list', async () => {
    tagAc(AC(19));
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', tags: [repoTag('memex-ai')] }),
    ]);

    mount();
    await screen.findByTestId('tag-chip');

    expect(screen.queryByTestId('tag-picker')).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/tag/i),
      'No field may invite a tag the surface cannot save.',
    ).not.toBeInTheDocument();
  });
});
