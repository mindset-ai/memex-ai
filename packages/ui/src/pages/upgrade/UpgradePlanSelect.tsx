import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../components/AuthContext';
import { PricingCard } from '../../components/upgrade/PricingCard';
import { fetchCurrentSubscription, type PlanTier } from '../../api/client';

const PLANS = [
  {
    id: 'premium' as const,
    name: 'Premium',
    badge: 'most teams start here',
    amount: 25,
    cadence: 'per seat, per month',
    audience: 'For growing teams needing collaboration at scale.',
    features: ['Unlimited Memexes', 'All core features'],
    ctaLabel: 'Upgrade to Premium',
    ctaHref: '/upgrade/premium',
    featured: true,
  },
  {
    id: 'enterprise' as const,
    name: 'Hosted Enterprise',
    amount: 50,
    cadence: 'per seat, per month',
    audience: 'For organisations with strict compliance and governance needs.',
    features: [
      'Everything in Premium',
      'Slack & Discord integrations',
      'Single sign-on (SSO)',
      'Priority support',
    ],
    ctaLabel: 'Upgrade to Enterprise',
    ctaHref: '/upgrade/enterprise',
  },
  {
    id: 'self-hosted-enterprise' as const,
    name: 'Self-Hosted Enterprise',
    amount: 30,
    cadence: 'per seat, per month',
    audience: 'For organisations who run their own infrastructure and LLM keys.',
    features: [
      'All governance features',
      'You run the infrastructure',
      'Bring your own LLM keys',
      'SSO & priority support',
    ],
    ctaLabel: 'Set up Self-Hosted',
    ctaHref: '/upgrade/self-hosted',
  },
] as const;

type PlanId = (typeof PLANS)[number]['id'];

function tierToPlanId(tier: PlanTier): PlanId | null {
  if (tier === 'premium') return 'premium';
  if (tier === 'enterprise') return 'enterprise';
  if (tier === 'self-hosted-enterprise') return 'self-hosted-enterprise';
  return null;
}

export function UpgradePlanSelect() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [currentPlanId, setCurrentPlanId] = useState<PlanId | null>(null);

  useEffect(() => {
    if (!token) return;
    fetchCurrentSubscription(token)
      .then((sub) => setCurrentPlanId(tierToPlanId(sub.tier)))
      .catch(() => {
        // Non-fatal: just don't highlight current plan
      });
  }, [token]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-heading">Choose your plan</h1>
        <p className="mt-1 text-sm text-muted">
          Upgrade your org to unlock more Memexes, governance features, and priority support.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        {PLANS.map((plan) => (
          <PricingCard
            key={plan.id}
            name={plan.name}
            badge={'badge' in plan ? plan.badge : undefined}
            amount={plan.amount}
            cadence={plan.cadence}
            audience={plan.audience}
            features={[...plan.features]}
            ctaLabel={plan.ctaLabel}
            ctaHref={plan.ctaHref}
            featured={'featured' in plan ? plan.featured : false}
            current={currentPlanId === plan.id}
          />
        ))}
      </div>

      <p className="mt-6 text-center text-xs text-muted">
        Already on a plan?{' '}
        <button
          className="underline hover:text-secondary"
          onClick={() => navigate('/org?tab=billing')}
        >
          Manage billing in Settings
        </button>
      </p>
    </div>
  );
}
