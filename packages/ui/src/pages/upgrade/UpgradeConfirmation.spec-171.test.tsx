// spec-171 issue-16 — the confirmation page polls the org that was purchased.
//
// After the full browser redirect back from stripe.com, React Router state is
// gone and the page can't tell WHICH org was purchased — so it rendered all
// fields as "—" (it was polling the session's current, non-billable personal
// memex, which is always 'free'). The success_url now carries `org=<ns>/<mx>`;
// the page reads it, polls fetchCurrentSubscription for THAT tenant, and fills
// Plan / Seats / Billing / Next billing date.
//
// NOTE: not tagged to an AC. The nearest, ac-39, is verified specifically by an
// e2e that "asserts the real POST URL carries that org's namespace" — i.e. the
// OUTBOUND checkout POST. This suite exercises the INBOUND confirmation-page
// poll (a different mechanism), so tagging ac-39 here would flip it to verified
// without exercising its stated claim. Left untagged; runs as a plain unit test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { UpgradeConfirmation } from './UpgradeConfirmation';
import type { SubscriptionDto, OrgTenant } from '../../api/client';

const { fetchCurrentSubscriptionMock } = vi.hoisted(() => ({
  fetchCurrentSubscriptionMock: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  fetchCurrentSubscription: fetchCurrentSubscriptionMock,
}));

// A session with TWO admin orgs → the single-admin heuristic can't disambiguate,
// so without the `org` param the page would fall back to the session current.
// The param must override that and pin the poll to the purchased org.
vi.mock('../../components/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', session: { sub: 'u1' } }),
  computeDefaultLanding: () => '/acme/main',
}));

vi.mock('./adminOrgs', () => ({
  deriveAdminOrgs: () => [
    { orgId: 'o1', namespace: 'acme', memexSlug: 'main' },
    { orgId: 'o2', namespace: 'beta', memexSlug: 'main' },
  ],
}));

function renderConfirmation(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/upgrade/confirmation${search}`]}>
      <Routes>
        <Route path="/upgrade/confirmation" element={<UpgradeConfirmation />} />
      </Routes>
    </MemoryRouter>,
  );
}

const PREMIUM_ANNUAL: SubscriptionDto = {
  tier: 'premium',
  seatsPurchased: 7,
  activeMemberCount: 3,
  billingCycle: 'annual',
  currentPeriodEnd: '2027-06-21T00:00:00.000Z',
  seatsWarning: null,
};

beforeEach(() => {
  fetchCurrentSubscriptionMock.mockReset();
});

describe('spec-171 issue-16: UpgradeConfirmation reads the org param + fills fields', () => {
  it('polls the org named in the `org` param and renders plan/seats/billing/date', async () => {
    fetchCurrentSubscriptionMock.mockResolvedValue(PREMIUM_ANNUAL);

    renderConfirmation('?session_id=cs_test_123&org=beta%2Fmain');

    await waitFor(() => expect(fetchCurrentSubscriptionMock).toHaveBeenCalled());

    // The poll targets the org from the PARAM (beta/main), not the first admin org.
    const tenantArg = fetchCurrentSubscriptionMock.mock.calls[0][1] as OrgTenant;
    expect(tenantArg).toEqual({ namespace: 'beta', memexSlug: 'main' });

    // Fields fill once the (non-free) tier resolves.
    await screen.findByText('Premium');
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Annual')).toBeInTheDocument();
    expect(screen.getByText(/June 21, 2027/)).toBeInTheDocument();
  });

  it('falls back gracefully when the org param is absent (legacy link)', async () => {
    fetchCurrentSubscriptionMock.mockResolvedValue(PREMIUM_ANNUAL);

    renderConfirmation('?session_id=cs_test_123');

    await waitFor(() => expect(fetchCurrentSubscriptionMock).toHaveBeenCalled());

    // Two admin orgs + no param → can't disambiguate → orgTenant is undefined
    // (the poll falls back to the session current; current behaviour preserved).
    const tenantArg = fetchCurrentSubscriptionMock.mock.calls[0][1];
    expect(tenantArg).toBeUndefined();
  });
});
