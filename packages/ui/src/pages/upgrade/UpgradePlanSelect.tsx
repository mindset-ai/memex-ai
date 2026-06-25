import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../components/AuthContext';
import { PricingCard } from '../../components/upgrade/PricingCard';
import { OrgSelector } from '../../components/upgrade/OrgSelector';
import { Button } from '../../components/ui/Button';
import { deriveAdminOrgs } from './adminOrgs';
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
] as const;

type PlanId = (typeof PLANS)[number]['id'];

function tierToPlanId(tier: PlanTier): PlanId | null {
  if (tier === 'premium') return 'premium';
  if (tier === 'enterprise') return 'enterprise';
  return null;
}

export function UpgradePlanSelect() {
  const { token, session } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [currentPlanId, setCurrentPlanId] = useState<PlanId | null>(null);

  // spec-171 verify (org-first flow): choose the org to bill HERE, on step 1,
  // not on the seats screen — so by the time a plan is picked the org is already
  // settled and never re-asked. Pre-select from ?org (carried in when the user
  // arrives from a specific org's billing tab) or auto-select the sole admin org.
  const adminOrgs = useMemo(() => deriveAdminOrgs(session), [session]);
  const orgParam = searchParams.get('org');
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => {
    if (orgParam && adminOrgs.some((o) => o.orgId === orgParam)) return orgParam;
    return adminOrgs.length === 1 ? adminOrgs[0].orgId : null;
  });
  // Whether the org chooser is open. The resting state is the confirmation card;
  // "Change" opens this, "Select organisation" closes it back to the card.
  const [editingOrg, setEditingOrg] = useState(false);

  // AuthContext fast-paints a cached session then refreshes /api/auth/me; the
  // admin org(s) may land AFTER mount. Resolve the pre-selection then too.
  useEffect(() => {
    if (selectedOrgId !== null) return;
    if (orgParam && adminOrgs.some((o) => o.orgId === orgParam)) {
      setSelectedOrgId(orgParam);
    } else if (adminOrgs.length === 1) {
      setSelectedOrgId(adminOrgs[0].orgId);
    }
  }, [adminOrgs, orgParam, selectedOrgId]);

  // Highlight the CURRENT plan of the CHOSEN org (each org bills independently).
  const selectedOrg = adminOrgs.find((o) => o.orgId === selectedOrgId) ?? null;
  useEffect(() => {
    if (!token || !selectedOrg) {
      setCurrentPlanId(null);
      return;
    }
    fetchCurrentSubscription(token, {
      namespace: selectedOrg.namespace,
      memexSlug: selectedOrg.memexSlug,
    })
      .then((sub) => setCurrentPlanId(tierToPlanId(sub.tier)))
      .catch(() => setCurrentPlanId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedOrgId]);

  function handleCreateOrg() {
    const personal = session?.memberships.find((m) => m.kind === 'personal');
    navigate(personal ? `/${personal.slug}` : '/');
  }

  // Carry the chosen org into the seats screen so it's shown read-only there.
  const orgQuery = selectedOrgId ? `?org=${selectedOrgId}` : '';

  // Org display: the resting state is a compact confirmation CARD (an org is
  // chosen and we're not editing). "Change" opens the chooser; "Select
  // organisation" confirms the pick back to the card. A cold multi-org load with
  // nothing chosen shows the chooser until a pick is made.

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-heading">Choose your plan</h1>
        <p className="mt-1 text-sm text-muted">
          Upgrade your org to unlock more Memexes, governance features, and priority support.
        </p>
      </div>

      {/* Step 1: which org are we upgrading? Billing is per-org (spec-171 t-25 /
          dec-40), so this is settled before a plan is picked. Resting state is a
          confirmation card; "Change" reveals the chooser, "Select organisation"
          confirms back to the card. */}
      {selectedOrg && !editingOrg ? (
        <div className="mb-8 max-w-md rounded-xl border border-edge-strong bg-panel p-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-muted">Upgrading organisation</p>
            <p className="mt-0.5 text-lg font-semibold text-heading truncate">
              {selectedOrg.name}
            </p>
          </div>
          {adminOrgs.length > 1 && (
            <Button
              variant="secondary"
              className="shrink-0"
              onClick={() => setEditingOrg(true)}
            >
              Change
            </Button>
          )}
        </div>
      ) : (
        <div className="mb-8 max-w-md space-y-3">
          <OrgSelector
            orgs={adminOrgs}
            selectedOrgId={selectedOrgId}
            onSelect={setSelectedOrgId}
            onCreateOrg={handleCreateOrg}
          />
          {editingOrg && (
            <Button
              variant="primary"
              disabled={!selectedOrgId}
              onClick={() => setEditingOrg(false)}
            >
              Select organisation
            </Button>
          )}
        </div>
      )}

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
            ctaHref={`${plan.ctaHref}${orgQuery}`}
            featured={'featured' in plan ? plan.featured : false}
            current={currentPlanId === plan.id}
            ctaDisabled={!selectedOrgId}
          />
        ))}
      </div>

      <p className="mt-6 text-center text-xs text-muted">
        Already on a plan?{' '}
        <button
          className="underline hover:text-secondary"
          onClick={() =>
            navigate(
              selectedOrg
                ? `/${selectedOrg.namespace}/${selectedOrg.memexSlug}/org?tab=billing`
                : '/org?tab=billing',
            )
          }
        >
          Manage billing in Settings
        </button>
      </p>
    </div>
  );
}
