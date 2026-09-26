import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The seats banner reads the org's subscription, an admin-only, org-scoped route. It must
// only ask where that request can succeed: otherwise every page load in a personal Memex
// (no org) or for a non-admin member logs a refused request as a browser console error.

let session: Record<string, unknown> | null = null;
vi.mock('../AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', session }),
}));

const fetchCurrentSubscription = vi.fn();
vi.mock('../../api/client', () => ({
  fetchCurrentSubscription: (...a: unknown[]) => fetchCurrentSubscription(...a),
}));

import { SeatsWarningBanner } from './SeatsWarningBanner';

function membership(fields: Record<string, unknown>) {
  return { memexId: 'mx', slug: 'acme', memexSlug: 'main', kind: 'team', role: 'administrator', ...fields };
}

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(
    <MemoryRouter>
      <SeatsWarningBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchCurrentSubscription.mockReset();
  fetchCurrentSubscription.mockResolvedValue({ seatsWarning: { purchased: 2, active: 5 } });
});
afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('SeatsWarningBanner', () => {
  it('asks for the subscription and shows the warning for a team administrator', async () => {
    session = { currentMemexId: 'mx', memberships: [membership({})] };
    renderAt('/acme/main/specs');
    expect(await screen.findByText(/seats purchased/i)).toBeInTheDocument();
    expect(fetchCurrentSubscription).toHaveBeenCalledTimes(1);
  });

  it('makes no request in a personal Memex', async () => {
    session = {
      currentMemexId: 'mx',
      memberships: [membership({ slug: 'dev', memexSlug: 'personal', kind: 'personal' })],
    };
    renderAt('/dev/personal/specs');
    await waitFor(() => expect(fetchCurrentSubscription).not.toHaveBeenCalled());
  });

  it('makes no request for a team member who is not an administrator', async () => {
    session = { currentMemexId: 'mx', memberships: [membership({ role: 'member' })] };
    renderAt('/acme/main/specs');
    await waitFor(() => expect(fetchCurrentSubscription).not.toHaveBeenCalled());
  });

  it('makes no request on a visited public Memex', async () => {
    session = { currentMemexId: 'mx', memberships: [membership({ source: 'visited' })] };
    renderAt('/acme/main/specs');
    await waitFor(() => expect(fetchCurrentSubscription).not.toHaveBeenCalled());
  });

  it('on a page with no tenant in the URL, follows the current Memex (personal: no request)', async () => {
    session = {
      currentMemexId: 'mx',
      memberships: [membership({ slug: 'dev', memexSlug: 'personal', kind: 'personal' })],
    };
    renderAt('/settings/profile');
    await waitFor(() => expect(fetchCurrentSubscription).not.toHaveBeenCalled());
  });

  it('on a page with no tenant in the URL, still warns a team administrator', async () => {
    session = { currentMemexId: 'mx', memberships: [membership({})] };
    renderAt('/settings/profile');
    expect(await screen.findByText(/seats purchased/i)).toBeInTheDocument();
  });
});
