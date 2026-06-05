import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const checkMemexSlugApi = vi.hoisted(() => vi.fn());
const createMemexApi = vi.hoisted(() => vi.fn());
const OrgApiErrorMock = vi.hoisted(() => class extends Error {
  status: number;
  code?: string;
  errorCode?: string;
  constructor(status: number, code: string | undefined, errorCode: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.errorCode = errorCode;
  }
});

vi.mock('../api/client', () => ({
  checkMemexSlugApi,
  createMemexApi,
  OrgApiError: OrgApiErrorMock,
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'fake-token' }),
}));

import { AddMemexDialog } from './AddMemexDialog';

const NAMESPACE = {
  namespaceId: 'ns-1',
  namespaceSlug: 'acme',
  orgName: 'Acme Co',
};

describe('AddMemexDialog', () => {
  beforeEach(() => {
    checkMemexSlugApi.mockReset();
    createMemexApi.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the locked copy from doc-19 section #3', () => {
    render(<AddMemexDialog {...NAMESPACE} onClose={() => {}} />);
    expect(screen.getByText(/Add a Memex to Acme Co/)).toBeInTheDocument();
    expect(screen.getByText(/A Memex is a living document/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add Memex/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('runs the slug availability check after the debounce and surfaces "Available"', async () => {
    checkMemexSlugApi.mockResolvedValue({ available: true });
    render(<AddMemexDialog {...NAMESPACE} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('main'), { target: { value: 'newmx' } });
    // 400ms debounce — wait long enough that real timers fire.
    await waitFor(
      () => {
        expect(checkMemexSlugApi).toHaveBeenCalledWith('ns-1', 'newmx', 'fake-token');
      },
      { timeout: 2000 },
    );
    await waitFor(() => expect(screen.getByText(/Available/)).toBeInTheDocument(), { timeout: 2000 });
  });

  it('renders inline error on slug_taken without closing the dialog', async () => {
    checkMemexSlugApi.mockResolvedValue({ available: true });
    createMemexApi.mockRejectedValue(new OrgApiErrorMock(409, 'slug_taken', 'slug_taken', 'taken'));
    const onClose = vi.fn();
    render(<AddMemexDialog {...NAMESPACE} onClose={onClose} />);

    const input = screen.getByPlaceholderText('main');
    fireEvent.change(input, { target: { value: 'taken' } });
    await waitFor(() => expect(screen.getByText(/Available/)).toBeInTheDocument(), {
      timeout: 2000,
    });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(screen.getByText(/Slug already taken/)).toBeInTheDocument(), {
      timeout: 2000,
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
