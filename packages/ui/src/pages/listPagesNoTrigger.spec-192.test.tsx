import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { PageHeader } from '../components/PageHeader';
import { StandardList } from './StandardList';
import { IssuesList } from './IssuesList';

// spec-192 t-4 (ac-9): the search trigger is wired in SpecList ONLY, never the
// shared PageHeader — so no OTHER list page carries one. We render the REAL
// (UNMOCKED) PageHeader directly, plus the real Issues and Standards pages, so a
// trigger leaking via the shared component — the exact failure ac-9 guards —
// would be caught rather than hidden behind a PageHeader stub.
//
// In-scope list pages: Specs (HAS the trigger — see SpecList.spec-192.test.tsx),
// Issues, Standards. Pulse / Insights / Scaffold / Drift also render through this
// same shared PageHeader, so the direct-PageHeader assertion below covers them
// transitively (none add a trigger locally).

const AC9 = 'mindset-prod/memex-building-itself/specs/spec-192/acs/ac-9';

vi.mock('../hooks/useDocChangeStream', () => ({ useDocChangeStream: () => {} }));
vi.mock('../components/StandardsMap', () => ({
  StandardsMap: () => <div data-testid="mock-standards-map" />,
}));
vi.mock('../components/NewSpecModal', () => ({ NewSpecModal: () => null }));

// Real PageHeader reads useAuth for the breadcrumb — give it a session so it
// renders (getCurrentTenant + useAnonymousPublicMemex are null-safe without
// providers). We deliberately DON'T mock PageHeader: that's the whole point.
vi.mock('../components/AuthContext', async () => {
  const real = await vi.importActual<typeof import('../components/AuthContext')>(
    '../components/AuthContext',
  );
  return {
    ...real,
    useAuth: () => ({
      session: {
        user: { id: 'u-1', email: 'a@example.com', name: 'Alice', status: 'active', emailVerified: true },
        memberships: [
          { memexId: 'mx-1', slug: 'alice', memexSlug: 'personal', name: 'Personal Memex', kind: 'personal', role: 'administrator' },
        ],
        currentMemexId: 'mx-1',
        currentRole: 'administrator',
        needsOnboarding: false,
        hiddenFeatures: [],
      },
    }),
  };
});

const fetchDocsMock = vi.fn();
const fetchMemexIssuesMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...a: unknown[]) => fetchDocsMock(...a),
  fetchMemexIssues: (...a: unknown[]) => fetchMemexIssuesMock(...a),
  updateIssueStatusApi: vi.fn(),
}));

beforeEach(() => {
  fetchDocsMock.mockResolvedValue([]);
  fetchMemexIssuesMock.mockResolvedValue([]);
});

function expectNoTrigger() {
  expect(screen.queryByTestId('search-palette-trigger-board')).not.toBeInTheDocument();
  expect(screen.queryByTestId('search-palette-trigger-header')).not.toBeInTheDocument();
}

describe('spec-192 t-4: only the Specs board carries a search trigger (ac-9)', () => {
  it('the SHARED PageHeader renders no search trigger (so no list page inherits one)', () => {
    tagAc(AC9);
    render(
      <MemoryRouter>
        <PageHeader title="Issues" actions={<button>an action</button>} />
      </MemoryRouter>,
    );
    expectNoTrigger();
  });

  it('the Standards page header has no search trigger', async () => {
    tagAc(AC9);
    render(
      <MemoryRouter>
        <StandardList />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Standards' });
    expectNoTrigger();
  });

  it('the Issues page header has no search trigger', async () => {
    tagAc(AC9);
    render(
      <MemoryRouter initialEntries={['/acme/main/issues']}>
        <Routes>
          <Route path="/:namespace/:memex/issues" element={<IssuesList />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Issues' });
    expectNoTrigger();
  });
});
