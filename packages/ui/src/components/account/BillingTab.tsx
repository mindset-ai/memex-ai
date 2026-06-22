import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import {
  fetchCurrentSubscription,
  fetchBillingPortalUrl,
  previewSeatChange,
  updateOrgSeats,
  type SubscriptionDto,
} from '../../api/client';
import { deriveAdminOrgs } from '../../pages/upgrade/adminOrgs';
import { OrgSelector } from '../upgrade/OrgSelector';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return iso;
  }
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
}

export function BillingTab() {
  const { token, session } = useAuth();
  const navigate = useNavigate();

  // spec-171 t-25 / dec-40 (option A): billing is per-org and /org is a flat
  // (non-tenant) route, so the session's current memex defaults to the
  // non-billable personal Memex. Resolve the billable org explicitly from the
  // orgs the caller administers and target ITS tenant base on every billing call.
  const adminOrgs = useMemo(() => deriveAdminOrgs(session), [session]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() =>
    adminOrgs.length === 1 ? adminOrgs[0].orgId : null,
  );
  const selectedOrg = adminOrgs.find((o) => o.orgId === selectedOrgId) ?? null;
  const orgTenant = selectedOrg
    ? { namespace: selectedOrg.namespace, memexSlug: selectedOrg.memexSlug }
    : undefined;

  // The state initializer runs once. AuthContext fast-paints a cached session
  // then refreshes /api/auth/me in the background; if the org arrives via that
  // refresh, adminOrgs becomes length-1 AFTER mount. Auto-select then so the
  // single-org case isn't stuck on the (control-less) read-only selector.
  useEffect(() => {
    if (selectedOrgId === null && adminOrgs.length === 1) {
      setSelectedOrgId(adminOrgs[0].orgId);
    }
  }, [adminOrgs, selectedOrgId]);

  const [sub, setSub] = useState<SubscriptionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Seat change state
  const [seatInput, setSeatInput] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ amountDue: number; currency: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    // No org chosen yet (0 admin orgs, or many and none picked): nothing to load.
    if (!orgTenant) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetchCurrentSubscription(token, orgTenant)
      .then((s) => { setSub(s); setSeatInput(s.seatsPurchased ?? 1); })
      .catch(() => setError('Could not load billing information.'))
      .finally(() => setLoading(false));
    // orgTenant is derived from selectedOrgId; re-fetch when the chosen org changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedOrgId]);

  async function handleBillingPortal() {
    if (!token) return;
    try {
      const url = await fetchBillingPortalUrl(token, window.location.href, orgTenant);
      window.open(url, '_blank', 'noopener');
    } catch {
      setError('Could not open billing portal. Please try again.');
    }
  }

  async function handlePreview(seats: number) {
    if (!token || !sub || sub.tier === 'free') return;
    setPreviewLoading(true);
    setPreview(null);
    try {
      const p = await previewSeatChange(token, seats, orgTenant);
      setPreview(p);
    } catch {
      // Non-fatal; user still sees the confirm button
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSeatConfirm() {
    if (!token || seatInput === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateOrgSeats(token, seatInput, orgTenant);
      setSub((prev) => prev ? { ...prev, seatsPurchased: seatInput } : prev);
      setConfirmOpen(false);
      setPreview(null);
    } catch {
      setSaveError('Failed to update seats. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function handleCreateOrg() {
    const personal = session?.memberships.find((m) => m.kind === 'personal');
    navigate(personal ? `/${personal.slug}` : '/');
  }

  // No billable org resolved yet: either the caller administers none (show the
  // create-an-org prompt) or several and hasn't picked one (show the chooser).
  // Either way there's no single org whose billing we can display.
  if (!selectedOrg) {
    return (
      <div className="py-6 space-y-4 max-w-xl">
        {adminOrgs.length > 1 && (
          <p className="text-sm text-muted">
            Choose which organisation's billing you want to manage.
          </p>
        )}
        <OrgSelector
          orgs={adminOrgs}
          selectedOrgId={selectedOrgId}
          onSelect={setSelectedOrgId}
          onCreateOrg={handleCreateOrg}
        />
      </div>
    );
  }

  if (loading) {
    return <div className="py-6 text-sm text-muted">Loading billing information…</div>;
  }

  if (error || !sub) {
    return <Alert variant="danger">{error ?? 'Could not load billing information.'}</Alert>;
  }

  const isFree = sub.tier === 'free';
  const isSelfHosted = sub.tier === 'self-hosted-enterprise';
  const isPaid = !isFree && !isSelfHosted;
  const tierLabel =
    sub.tier === 'premium' ? 'Premium' :
    sub.tier === 'enterprise' ? 'Hosted Enterprise' :
    sub.tier === 'self-hosted-enterprise' ? 'Self-Hosted Enterprise' :
    'Cloud Free';

  return (
    <div className="py-6 space-y-6 max-w-xl">
      {/* Which org's billing is shown — switchable when the caller admins many.
          spec-171 t-25: never assume the session's current memex is the org. */}
      {adminOrgs.length > 1 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-surface/50 px-4 py-2.5">
          <div>
            <p className="text-xs text-muted">Managing organisation</p>
            <p className="text-sm font-medium text-primary">{selectedOrg.name}</p>
          </div>
          <button
            type="button"
            className="text-xs text-link underline hover:no-underline"
            onClick={() => setSelectedOrgId(null)}
          >
            Switch organisation
          </button>
        </div>
      )}

      {/* Seats warning banner */}
      {sub.seatsWarning && (
        <Alert variant="warning">
          Your org has <strong>{sub.seatsWarning.active}</strong> active members but only{' '}
          <strong>{sub.seatsWarning.purchased}</strong> seats purchased.{' '}
          {isPaid && (
            <button
              className="underline font-medium"
              onClick={() => { setSeatInput(sub.seatsWarning!.active); handlePreview(sub.seatsWarning!.active); setConfirmOpen(true); }}
            >
              Add seats →
            </button>
          )}
        </Alert>
      )}

      {/* Current plan */}
      <section className="rounded-lg border border-edge bg-panel p-5 space-y-3">
        <h3 className="text-sm font-semibold text-heading">Current plan</h3>
        <dl className="divide-y divide-edge">
          {[
            ['Plan', tierLabel],
            ['Seats purchased', isFree ? '—' : String(sub.seatsPurchased ?? '—')],
            ['Active members', String(sub.activeMemberCount)],
            ['Billing cycle', sub.billingCycle ?? '—'],
            ['Next billing date', formatDate(sub.currentPeriodEnd)],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between py-2 text-sm">
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium text-primary">{value}</dd>
            </div>
          ))}
        </dl>

        {isFree && (
          <Button variant="primary" onClick={() => navigate('/upgrade')}>
            Upgrade plan
          </Button>
        )}
      </section>

      {/* Self-hosted: contact sales for seat changes */}
      {isSelfHosted && (
        <section className="rounded-lg border border-edge bg-panel p-5 space-y-2">
          <h3 className="text-sm font-semibold text-heading">Change seats</h3>
          <p className="text-sm text-muted">
            Self-hosted seat changes are handled by our sales staff.
          </p>
          <Button variant="secondary" onClick={() => navigate('/enterprise/self-hosted/contact')}>
            Contact sales to change seats
          </Button>
        </section>
      )}

      {/* Paid hosted: self-service seat change */}
      {isPaid && (
        <section className="rounded-lg border border-edge bg-panel p-5 space-y-3">
          <h3 className="text-sm font-semibold text-heading">Change seats</h3>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-muted mb-1" htmlFor="seat-change-input">
                Number of seats
              </label>
              <input
                id="seat-change-input"
                type="number"
                min={1}
                value={seatInput ?? ''}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 1) {
                    setSeatInput(v);
                    setPreview(null);
                  }
                }}
                className="w-full rounded-lg border border-edge bg-input px-3 py-2 text-sm text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
              />
            </div>
            <Button
              variant="secondary"
              disabled={previewLoading || seatInput === sub.seatsPurchased}
              onClick={() => seatInput && handlePreview(seatInput).then(() => setConfirmOpen(true))}
            >
              {previewLoading ? 'Calculating…' : 'Change seats'}
            </Button>
          </div>
          <p className="text-xs text-muted">
            Changes take effect immediately. Proration is calculated based on time remaining in billing period.
          </p>
        </section>
      )}

      {/* Billing portal */}
      {!isFree && (
        <section className="rounded-lg border border-edge bg-panel p-5 space-y-2">
          <h3 className="text-sm font-semibold text-heading">Payment & invoices</h3>
          <p className="text-sm text-muted">
            Manage your payment method, download invoices, and cancel your subscription.
          </p>
          <Button variant="secondary" onClick={handleBillingPortal}>
            Manage payment method and view invoices ↗
          </Button>
        </section>
      )}

      {/* Seat change confirmation modal */}
      {confirmOpen && seatInput !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
          <div className="bg-panel border border-edge rounded-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-base font-semibold text-heading">
              Change seat count from {sub.seatsPurchased} to {seatInput}?
            </h3>
            {preview && (
              <p className="text-sm text-secondary">
                {preview.amountDue >= 0
                  ? `Prorated charge: ${formatCurrency(preview.amountDue, preview.currency)} (billed today)`
                  : `Prorated credit: ${formatCurrency(Math.abs(preview.amountDue), preview.currency)} (applied to next invoice)`}
              </p>
            )}
            {saveError && <Alert variant="danger">{saveError}</Alert>}
            <div className="flex gap-3">
              <Button
                variant="primary"
                className="flex-1 justify-center"
                disabled={saving}
                onClick={handleSeatConfirm}
              >
                {saving ? 'Saving…' : 'Confirm'}
              </Button>
              <Button
                variant="secondary"
                className="flex-1 justify-center"
                disabled={saving}
                onClick={() => { setConfirmOpen(false); setSaveError(null); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
