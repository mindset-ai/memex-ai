import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DocumentList } from './DocumentList';
import type { DocSummary } from '../api/types';

vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));

const fetchDocsMock = vi.fn();
vi.mock('../api/client', () => ({
  fetchDocs: (...args: unknown[]) => fetchDocsMock(...args),
}));

function doc(overrides: Partial<DocSummary> = {}): DocSummary {
  return {
    id: 'd-1',
    handle: 'doc-1',
    title: 'Untitled',
    docType: 'spec',
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

describe('DocumentList', () => {
  it('renders the empty state when nothing matches', async () => {
    fetchDocsMock.mockResolvedValueOnce([]);

    render(
      <MemoryRouter>
        <DocumentList />
      </MemoryRouter>
    );

    expect(await screen.findByText(/No documents yet/i)).toBeInTheDocument();
  });

  it('renders only docs that are NOT specs or standards', async () => {
    // DocumentList filters out `spec` and `standard` docTypes — both have
    // their own primitive-specific list pages.
    fetchDocsMock.mockResolvedValueOnce([
      doc({ id: 'd-1', title: 'A runbook', docType: 'runbook', handle: 'doc-1' }),
      doc({ id: 'd-2', title: 'An ADR', docType: 'adr', handle: 'doc-2' }),
      doc({ id: 'd-3', title: 'A spec', docType: 'spec', handle: 'spec-3' }),
      doc({ id: 'd-4', title: 'A standard', docType: 'standard', handle: 'std-4' }),
    ]);

    render(
      <MemoryRouter>
        <DocumentList />
      </MemoryRouter>
    );

    expect(await screen.findByText('A runbook')).toBeInTheDocument();
    expect(screen.getByText('An ADR')).toBeInTheDocument();
    expect(screen.queryByText('A spec')).not.toBeInTheDocument();
    expect(screen.queryByText('A standard')).not.toBeInTheDocument();
  });

  it('shows the docType and handle on each card', async () => {
    fetchDocsMock.mockResolvedValueOnce([
      doc({ id: 'd-1', title: 'Auth ADR', docType: 'adr', handle: 'doc-7' }),
    ]);

    render(
      <MemoryRouter>
        <DocumentList />
      </MemoryRouter>
    );

    await screen.findByText('Auth ADR');
    expect(screen.getByText('adr')).toBeInTheDocument();
    expect(screen.getByText('doc-7')).toBeInTheDocument();
  });
});
