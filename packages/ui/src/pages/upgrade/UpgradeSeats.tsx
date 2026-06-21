import { useState } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../components/AuthContext';
import { startCheckout } from '../../api/client';

type UpgradePlan = 'premium' | 'enterprise';

const PLAN_CONFIG: Record<UpgradePlan, { name: string; monthlyPrice: number }> = {
  premium:    { name: 'Premium',          monthlyPrice: 25 },
  enterprise: { name: 'Hosted Enterprise', monthlyPrice: 50 },
};

const ANNUAL_FACTOR = 0.83;

function calcPrice(seats: number, monthly: number, annual: boolean): number {
  return seats * monthly * (annual ? ANNUAL_FACTOR : 1);
}

export function UpgradeSeats() {
  const { plan } = useParams<{ plan: string }>();
  const navigate = useNavigate();
  const { token } = useAuth();

  const [seats, setSeats] = useState(1);
  const [annual, setAnnual] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!plan || !(plan in PLAN_CONFIG)) {
    return <Navigate to="/upgrade" replace />;
  }

  const config = PLAN_CONFIG[plan as UpgradePlan];
  const total = calcPrice(seats, config.monthlyPrice, annual);
  const perSeat = config.monthlyPrice * (annual ? ANNUAL_FACTOR : 1);

  async function handleContinue() {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // spec-171 dec-38 / ac-33: redirect to Stripe-hosted Checkout. Card data
      // is collected on Stripe's page, never in our UI.
      const { url } = await startCheckout(
        { plan: plan as UpgradePlan, seats, billingCycle: annual ? 'annual' : 'monthly' },
        token,
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
              if (!isNaN(v) && v >= 1) setSeats(v);
            }}
            className="w-full rounded-lg border border-edge bg-input px-3 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <p className="mt-1.5 text-xs text-muted">
            ${perSeat.toFixed(2)}/seat/mo · no maximum
          </p>
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
          disabled={submitting}
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
