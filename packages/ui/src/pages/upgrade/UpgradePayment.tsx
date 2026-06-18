import { useRef, useState } from 'react';
import { useParams, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../../components/AuthContext';
import { StripeCardElement } from '../../components/upgrade/StripeCardElement';
import { createOrgSubscription, CardDeclinedError } from '../../api/client';

interface UpgradeState {
  plan: 'premium' | 'enterprise';
  seats: number;
  annual: boolean;
  planName: string;
  monthlyPrice: number;
}

const ANNUAL_FACTOR = 0.83;

export function UpgradePayment() {
  const { plan } = useParams<{ plan: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { token } = useAuth();

  const state = location.state as UpgradeState | null;

  const stripeRef = useRef<StripeInstance | null>(null);
  const cardRef = useRef<StripeCardElement | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state || !plan || (plan !== 'premium' && plan !== 'enterprise')) {
    return <Navigate to="/upgrade" replace />;
  }

  const { seats, annual, planName, monthlyPrice } = state;
  const perMonth = monthlyPrice * (annual ? ANNUAL_FACTOR : 1);
  const total = seats * perMonth;

  function handleReady(card: StripeCardElement, stripe: StripeInstance) {
    cardRef.current = card;
    stripeRef.current = stripe;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cardRef.current || !stripeRef.current || submitting) return;

    setError(null);
    setSubmitting(true);

    try {
      const { paymentMethod, error: stripeError } = await stripeRef.current.createPaymentMethod({
        type: 'card',
        card: cardRef.current,
      });

      if (stripeError || !paymentMethod) {
        setError(stripeError?.message ?? 'Could not process card. Please try again.');
        return;
      }

      const result = await createOrgSubscription(
        {
          plan,
          seats,
          billingCycle: annual ? 'annual' : 'monthly',
          paymentMethodId: paymentMethod.id,
        },
        token,
      );

      navigate('/upgrade/confirmation', {
        replace: true,
        state: {
          planName,
          seats,
          annual,
          currentPeriodEnd: result.currentPeriodEnd,
        },
      });
    } catch (err) {
      if (err instanceof CardDeclinedError) {
        setError('Your card was declined. Please try a different payment method.');
      } else {
        setError('Payment failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <button
        className="mb-6 text-sm text-muted hover:text-secondary flex items-center gap-1"
        onClick={() => navigate(`/upgrade/${plan}`, { state })}
      >
        ← Back
      </button>

      <h1 className="text-2xl font-bold text-heading mb-8">Complete your purchase</h1>

      {/* Summary box */}
      <dl className="mb-8 rounded-lg border border-edge bg-surface/50 divide-y divide-edge">
        {[
          ['Plan', planName],
          ['Seats', String(seats)],
          ['Billing', annual ? 'Annual (save 17%)' : 'Monthly'],
          ['Total', `$${total.toFixed(2)}/mo${annual ? ` · billed $${(total * 12).toFixed(2)}/yr` : ''}`],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between px-4 py-3 text-sm">
            <dt className="text-muted">{label}</dt>
            <dd className="font-medium text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-primary mb-1.5">
            Card details
          </label>
          <StripeCardElement
            onReady={handleReady}
            onError={(msg) => setError(msg)}
          />
        </div>

        {error && (
          <p
            role="alert"
            className="text-sm text-status-danger-text bg-status-danger-bg rounded-lg px-3 py-2"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2.5 text-sm font-medium rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Processing…' : 'Complete purchase'}
        </button>

        <p className="text-center text-xs text-muted">
          Secured by Stripe. Your card details never touch our servers.
        </p>
      </form>
    </div>
  );
}
