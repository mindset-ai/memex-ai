import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { StandardList } from './StandardList';
import type { DocSummary } from '../api/types';

// Echoes the current location so we can assert badge-click navigation.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

const fetchDocsMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
}));

// PageHeader pulls AuthContext for the Org/Memex breadcrumb. Stub so we
// don't have to wire AuthProvider in every page test.
vi.mock('../components/PageHeader', () => ({
  PageHeader: ({
    title,
    actions,
  }: {
    title: string;
    actions?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));

function standard(overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    id: 'b-1',
    handle: 'std-100',
    title: 'Untitled standard',
    docType: 'standard',
    status: 'draft',
    parentDocId: null,
    createdAt: '2025-01-01T00:00:00Z',
    statusChangedAt: '2025-01-01T00:00:00Z',
    sectionCount: 0,
    pausedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StandardList', () => {
  it('queries the server-side aggregate (driftCount inline) in one round-trip', async () => {
    fetchDocsMock.mockResolvedValueOnce([]);

    render(
      <MemoryRouter>
        <StandardList />
      </MemoryRouter>
    );

    await screen.findByText(/No standards yet/i);
    expect(fetchDocsMock).toHaveBeenCalledWith('standard', { include: ['driftCount'] });
    // Critically: only ONE call. Confirms the N+1 fan-out is gone.
    expect(fetchDocsMock).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state when no standards exist', async () => {
    fetchDocsMock.mockResolvedValueOnce([]);

    render(
      <MemoryRouter>
        <StandardList />
      </MemoryRouter>
    );

    expect(await screen.findByText(/No standards yet/i)).toBeInTheDocument();
  });

  it('renders standard titles with their handles', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', title: 'Caching rules', handle: 'std-100' }),
    ]);

    render(
      <MemoryRouter>
        <StandardList />
      </MemoryRouter>
    );

    expect(await screen.findByText('Caching rules')).toBeInTheDocument();
    expect(screen.getByText('std-100')).toBeInTheDocument();
  });

  it('does NOT render a drift badge when driftCount is 0 or omitted', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', title: 'Calm standard', driftCount: 0 }),
    ]);

    render(
      <MemoryRouter>
        <StandardList />
      </MemoryRouter>
    );

    await screen.findByText('Calm standard');
    expect(screen.queryByTestId('standard-drift-count')).not.toBeInTheDocument();
  });

  it('renders the drift count badge from the inline aggregate', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', title: 'Drifty standard', driftCount: 2 }),
    ]);

    render(
      <MemoryRouter>
        <StandardList />
      </MemoryRouter>
    );

    const badge = await screen.findByTestId('standard-drift-count');
    expect(badge).toHaveTextContent('2 drift');
  });

  it('drift badge deep-links into the Drift Inbox filtered to this standard (b-63)', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', title: 'Drifty standard', handle: 'std-100', driftCount: 2 }),
    ]);

    render(
      <MemoryRouter initialEntries={['/']}>
        <StandardList />
        <LocationProbe />
      </MemoryRouter>
    );

    const badge = await screen.findByTestId('standard-drift-count');
    fireEvent.click(badge);

    const loc = screen.getByTestId('loc').textContent ?? '';
    expect(loc).toContain('/drift');
    expect(loc).toContain('doc=std-100');
  });

  it('Copy audit prompt button writes a templated prompt to the clipboard (t-11)', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      standard({ id: 'b-1', title: 'Drifty standard' }),
      standard({ id: 'b-2', title: 'Caching rules' }),
    ]);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(
      <MemoryRouter>
        <StandardList />
      </MemoryRouter>
    );

    const button = await screen.findByTestId('copy-audit-prompt');
    fireEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const prompt = writeText.mock.calls[0][0] as string;
    // The prompt names the right Memex (derived from the test hostname),
    // tells the agent how many standards to check, and references the
    // canonical MCP tools the agent is supposed to use.
    // doc-14: list_standards folded into list_docs({ docType: 'standard' }).
    expect(prompt).toContain("list_docs({ docType: 'standard' })");
    expect(prompt).toContain('flag_drift');
    expect(prompt).toContain('propose_standard_change');
    expect(prompt).toContain('2 standards');

    // After click, the button label flips to "Copied!" so the user gets
    // visible feedback before the 2-second reset timer fires.
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
  });

  it('disables the copy-audit-prompt button when there are no standards', async () => {
    fetchDocsMock.mockResolvedValueOnce([]);
    render(
      <MemoryRouter>
        <StandardList />
      </MemoryRouter>
    );
    const button = await screen.findByTestId('copy-audit-prompt');
    expect(button).toBeDisabled();
  });
});
