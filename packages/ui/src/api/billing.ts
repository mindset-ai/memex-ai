// spec-354 sol-2: carved out of the former all-domains api/client.ts (which
// is now a barrel re-exporting this module). Behaviour-preserving move only.

import { fetchWithRetry, authHeaders } from './http';
import type { OrgTenant } from './internal';
import { orgBillingBase } from './internal';

export type PlanTier = 'free' | 'premium' | 'enterprise' | 'self-hosted-enterprise';

export interface SubscriptionDto {
  tier: PlanTier;
  seatsPurchased: number | null;
  activeMemberCount: number;
  billingCycle: 'monthly' | 'annual' | null;
  currentPeriodEnd: string | null;
  seatsWarning: { purchased: number; active: number } | null;
}

export async function fetchCurrentSubscription(
  token: string | null,
  orgTenant?: OrgTenant,
): Promise<SubscriptionDto> {
  const res = await fetchWithRetry(`${orgBillingBase(orgTenant)}/orgs/current/subscription`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch subscription: ${res.status}`);
  return res.json();
}

export interface StartCheckoutInput {
  plan: 'premium' | 'enterprise';
  seats: number;
  billingCycle: 'monthly' | 'annual';
}

export async function fetchBillingPortalUrl(
  token: string | null,
  returnUrl: string,
  orgTenant?: OrgTenant,
): Promise<string> {
  const url = `${orgBillingBase(orgTenant)}/orgs/current/billing-portal?returnUrl=${encodeURIComponent(returnUrl)}`;
  const res = await fetchWithRetry(url, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`Billing portal request failed: ${res.status}`);
  const body = await res.json();
  return body.url as string;
}

export async function previewSeatChange(
  token: string | null,
  seats: number,
  orgTenant?: OrgTenant,
): Promise<{ prorationAmount: number; recurringAmount: number; currency: string }> {
  const res = await fetchWithRetry(
    `${orgBillingBase(orgTenant)}/orgs/current/subscription/preview?seats=${seats}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) throw new Error(`Preview failed: ${res.status}`);
  return res.json();
}

export async function updateOrgSeats(
  token: string | null,
  seats: number,
  orgTenant?: OrgTenant,
): Promise<void> {
  const res = await fetchWithRetry(`${orgBillingBase(orgTenant)}/orgs/current/subscription`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify({ seats }),
  });
  if (!res.ok) throw new Error(`Seat update failed: ${res.status}`);
}

// spec-171 dec-38 / ac-33: start a hosted purchase. Returns the Stripe-hosted
// Checkout URL — the caller redirects the browser to it. No card data is ever
// collected in our UI.
//
// spec-171 t-25 / dec-40 (option A): the caller MUST pass the chosen org's
// tenant — billing is per-org and we must NOT bill the session's current memex
// (which defaults to the non-billable personal Memex). The POST therefore
// targets /api/<org-ns>/<org-mx>/orgs/current/subscription, where the server
// resolves the org FROM that memex.
export async function startCheckout(
  input: StartCheckoutInput,
  token: string | null,
  orgTenant: OrgTenant,
): Promise<{ url: string }> {
  const res = await fetchWithRetry(`${orgBillingBase(orgTenant)}/orgs/current/subscription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Checkout start failed: ${res.status}`);
  return res.json();
}
