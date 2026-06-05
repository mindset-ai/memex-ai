import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockSession = vi.hoisted(() => ({ value: null as null | { memberships: Array<{ kind: 'personal' | 'team' }> } }));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ session: mockSession.value }),
}));

// CreateOrgDialog drags in the form + slug-availability fetch. Stub it.
vi.mock('./CreateOrgDialog', () => ({
  CreateOrgDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="create-org-dialog">
      <button onClick={onClose}>close</button>
    </div>
  ),
}));

import { CreateOrgBanner } from './CreateOrgBanner';

describe('CreateOrgBanner', () => {
  let storage: Record<string, string>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((k: string) => storage[k] ?? null),
      setItem: vi.fn((k: string, v: string) => { storage[k] = v; }),
      removeItem: vi.fn((k: string) => { delete storage[k]; }),
      clear: vi.fn(() => { storage = {}; }),
    });
    mockSession.value = { memberships: [{ kind: 'personal' }] };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the banner when the user has only a personal membership', () => {
    render(<CreateOrgBanner />);
    expect(screen.getByText(/Working with a team/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create an Org/ })).toBeInTheDocument();
  });

  it('opens CreateOrgDialog when the CTA is clicked', () => {
    render(<CreateOrgBanner />);
    fireEvent.click(screen.getByRole('button', { name: /Create an Org/ }));
    expect(screen.getByTestId('create-org-dialog')).toBeInTheDocument();
  });

  it('does NOT render when the user has any team membership', () => {
    mockSession.value = {
      memberships: [{ kind: 'personal' }, { kind: 'team' }],
    };
    render(<CreateOrgBanner />);
    expect(screen.queryByText(/Working with a team/)).not.toBeInTheDocument();
  });

  it('dismiss button hides the banner and persists', () => {
    render(<CreateOrgBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Working with a team/)).not.toBeInTheDocument();
    expect(storage['createOrgBanner:dismissed:v1']).toBe('1');
  });

  it('respects the persisted dismissal on remount', () => {
    storage['createOrgBanner:dismissed:v1'] = '1';
    render(<CreateOrgBanner />);
    expect(screen.queryByText(/Working with a team/)).not.toBeInTheDocument();
  });

  it('renders when session has no memberships array (no team membership)', () => {
    mockSession.value = { memberships: [] };
    render(<CreateOrgBanner />);
    expect(screen.getByText(/Working with a team/)).toBeInTheDocument();
  });
});
