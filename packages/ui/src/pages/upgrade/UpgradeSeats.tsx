import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../components/AuthContext';
import { OrgSelector } from '../../components/upgrade/OrgSelector';
import { startCheckout } from '../../api/client';
import { PLAN_CONFIG, ANNUAL_FACTOR, calcPrice, type UpgradePlan } from './pricing';
import { deriveAdminOrgs } from './adminOrgs';

export function UpgradeSeats() {
  const { plan } = useParams<{ plan: string }>();
  const navigate = useNavigate();
  const { token, session } = useAuth();

  // spec-171 t-25 / dec-40 (option A): billing is per-org. Derive the orgs the
  // caller administers from the session and let them pick WHICH to upgrade —
  // never the session's current (personal) Memex.
  const adminOrgs = useMemo(() => deriveAdminOrgs(session), [session]);

  const [seats, setSeats] = useState(1);
  const [seatError, setSeatError] = useState<string | null>(null);
  const [annual, setAnnual] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Preselect when exactly one org; otherwise force an explicit choice.
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() =>
    adminOrgs.length === 1 ? adminOrgs[0].orgId : null,
  );

  // The state initializer runs once. AuthContext fast-paints a cached session
  // then refreshes /api/auth/me in the background; if the org arrives via that
  // refresh, adminOrgs becomes length-1 AFTER mount. Auto-select then so the
  // single-org case isn't stuck unselected (its read-only view has no manual
  // select control).
  useEffect(() => {
    if (selectedOrgId === null && adminOrgs.length === 1) {
      setSelectedOrgId(adminOrgs[0].orgId);
    }
  }, [adminOrgs, selectedOrgId]);

  if (!plan || !(plan in PLAN_CONFIG)) {
    return <Navigate to="/upgrade" replace />;
  }

  const config = PLAN_CONFIG[plan as UpgradePlan];
  const total = calcPrice(seats, config.monthlyPrice, annual);
  const perSeat = config.monthlyPrice * (annual ? ANNUAL_FACTOR : 1);

  const selectedOrg = adminOrgs.find((o) => o.orgId === selectedOrgId) ?? null;

  // Send the user to their personal namespace home, where the "Create an Org"
  // dialog lives. Personal-namespace rows are excluded from adminOrgs, so read
  // the personal slug straight off the session memberships.
  function handleCreateOrg() {
    const personal = session?.memberships.find((m) => m.kind === 'personal');
    navigate(personal ? `/${personal.slug}` : '/');
  }

  async function handleContinue() {
    if (submitting) return;
    if (!selectedOrg) {
      setError('Select the organisation you want to upgrade.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // spec-171 dec-38 / ac-33: redirect to Stripe-hosted Checkout. Card data
      // is collected on Stripe's page, never in our UI.
      // spec-171 t-25 / dec-40: bill the CHOSEN org — target its tenant base,
      // not the session's current memex.
      const { url } = await startCheckout(
        { plan: plan as UpgradePlan, seats, billingCycle: annual ? 'annual' : 'monthly' },
        token,
        { namespace: selectedOrg.namespace, memexSlug: selectedOrg.memexSlug },
      );
      window.location.assign(url);
    } catch {
      setError('Could not start checkout. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <button
        className="mb-6 text-sm text-muted hover:text-secondary flex items-center gap-1"
        onClick={() => navigate('/upgrade')}
      >
        ← Back to plans
      </button>

      <h1 className="text-2xl font-bold text-heading mb-1">
        Upgrade to {config.name}
      </h1>
      <p className="text-sm text-muted mb-8">
        ${config.monthlyPrice}/seat/mo · unlimited Memexes
      </p>

      <div className="space-y-6">
        {/* Org selector — billing is per-org (spec-171 t-25 / dec-40). */}
        <OrgSelector
          orgs={adminOrgs}
          selectedOrgId={selectedOrgId}
          onSelect={setSelectedOrgId}
          onCreateOrg={handleCreateOrg}
        />

        {/* Seat count */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1.5" htmlFor="seat-count">
            Number of seats
          </label>
          <input
            id="seat-count"
            type="number"
            min={1}
            value={seats}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              // ac-21: seat count must be ≥1. Surface a visible error on 0/<1
              // (or a non-numeric entry) instead of silently swallowing it.
              if (!isNaN(v) && v >= 1) {
                setSeats(v);
                setSeatError(null);
              } else {
                setSeatError('Enter at least 1 seat.');
              }
            }}
            aria-invalid={seatError !== null}
            className="w-full rounded-lg border border-edge bg-input px-3 py-2 text-sm text-primary focus:outline-hidden focus:ring-2 focus:ring-accent"
          />
          {seatError ? (
            <p role="alert" className="mt-1.5 text-xs text-status-danger-text">
              {seatError}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-muted">
              ${perSeat.toFixed(2)}/seat/mo · no maximum
            </p>
          )}
        </div>

        {/* Billing cycle */}
        <fieldset>
          <legend className="block text-sm font-medium text-primary mb-1.5">
            Billing cycle
          </legend>
          <div className="space-y-2">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name="billing-cycle"
                checked={!annual}
                onChange={() => setAnnual(false)}
                className="accent-accent"
              />
              <span className="text-sm text-primary">Monthly</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="radio"
                name="billing-cycle"
                checked={annual}
                onChange={() => setAnnual(true)}
                className="accent-accent"
              />
              <span className="text-sm text-primary">
                Annual{' '}
                <span className="ml-1 text-xs font-medium text-status-success-text">
                  save 17%
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        {/* Live price */}
        <div className="rounded-lg border border-edge bg-surface/50 px-4 py-3 flex items-baseline justify-between">
          <span className="text-sm text-muted">
            {seats} seat{seats !== 1 ? 's' : ''} · {annual ? 'annual' : 'monthly'}
          </span>
          <span className="text-xl font-bold text-heading">
            ${total.toFixed(2)}
            <span className="ml-1 text-sm font-normal text-muted">/mo</span>
          </span>
        </div>

        {annual && (
          <p className="text-xs text-muted text-right -mt-2">
            Billed as ${(total * 12).toFixed(2)}/year
          </p>
        )}

        <p className="text-xs text-muted text-right">
          Prices shown in USD · billed in your local currency at checkout.
        </p>

        {error && (
          <p
            role="alert"
            className="text-sm text-status-danger-text bg-status-danger-bg rounded-lg px-3 py-2"
          >
            {error}
          </p>
        )}

        <Button
          variant="primary"
          className="w-full justify-center py-2.5"
          onClick={handleContinue}
          disabled={submitting || !selectedOrg}
        >
          {submitting ? 'Redirecting…' : 'Continue to payment →'}
        </Button>

        <p className="text-center text-xs text-muted">
          You'll be redirected to Stripe to complete payment securely.
        </p>
      </div>
    </div>
  );
}
