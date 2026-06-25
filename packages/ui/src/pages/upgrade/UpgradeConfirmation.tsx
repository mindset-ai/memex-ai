import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams, Navigate } from 'react-router-dom';
import { useAuth } from '../../components/AuthContext';
import { computeDefaultLanding } from '../../components/AuthContext';
import { fetchCurrentSubscription, type SubscriptionDto } from '../../api/client';
import { deriveAdminOrgs } from './adminOrgs';

// spec-171 dec-38 / ac-33: this page is the Stripe Checkout `success_url`
// target. The user lands here via a FULL browser redirect from stripe.com, so
// React Router `location.state` is gone — we can't rely on it. Two cases:
//   - In-app navigation still carrying state (legacy / direct nav): use it.
//   - Stripe redirect (success_url carries ?session_id=...): fetch the live
//     subscription. The `checkout.session.completed` webhook may not have
//     persisted the row yet, so a 'free' tier is treated as "finalizing"
//     rather than an error, and we briefly poll.
interface ConfirmationState {
  planName: string;
  seats: number;
  annual: boolean;
  currentPeriodEnd: string;
}

const PLAN_LABELS: Record<string, string> = {
  premium: 'Premium',
  enterprise: 'Hosted Enterprise',
  'self-hosted-enterprise': 'Self-Hosted Enterprise',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function UpgradeConfirmation() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { token, session } = useAuth();

  const routerState = location.state as ConfirmationState | null;
  const sessionId = searchParams.get('session_id');
  const orgParam = searchParams.get('org');

  // spec-171 t-25 / dec-40 / issue-16: billing is per-org. After a Stripe
  // redirect the router state is gone, so we poll the live subscription — but it
  // MUST target the org that was upgraded, not the session's current (personal)
  // Memex (which is always 'free' → the poll would never resolve and the paying
  // user would see "Finalizing…" forever).
  //   - Preferred: the `org=<ns>/<mx>` param the success_url carries (issue-16)
  //     names the purchased org unambiguously.
  //   - Fallback: when the param is absent (legacy link) and the caller
  //     administers exactly one org, resolve it from the session. With several
  //     orgs and no param we can't tell, so the poll falls back to the session
  //     current and times out into the "active" view (the webhook still applied
  //     the tier).
  const adminOrgs = useMemo(() => deriveAdminOrgs(session), [session]);
  const paramTenant = useMemo(() => {
    if (!orgParam) return undefined;
    const slash = orgParam.indexOf('/');
    if (slash <= 0 || slash === orgParam.length - 1) return undefined;
    return {
      namespace: orgParam.slice(0, slash),
      memexSlug: orgParam.slice(slash + 1),
    };
  }, [orgParam]);
  const orgTenant =
    paramTenant ??
    (adminOrgs.length === 1
      ? { namespace: adminOrgs[0].namespace, memexSlug: adminOrgs[0].memexSlug }
      : undefined);

  const [sub, setSub] = useState<SubscriptionDto | null>(null);
  const [finalizing, setFinalizing] = useState(!routerState && !!sessionId);

  // When we arrived via Stripe redirect (no router state), poll the live
  // subscription until the webhook has persisted the new tier.
  useEffect(() => {
    if (routerState || !sessionId || !token) return;
    let cancelled = false;
    let attempts = 0;

    async function poll() {
      attempts += 1;
      try {
        const s = await fetchCurrentSubscription(token, orgTenant);
        if (cancelled) return;
        setSub(s);
        if (s.tier !== 'free') {
          setFinalizing(false);
          return;
        }
      } catch {
        // transient — keep trying
      }
      if (!cancelled && attempts < 6) {
        setTimeout(poll, 1500);
      } else if (!cancelled) {
        setFinalizing(false);
      }
    }
    void poll();
    return () => {
      cancelled = true;
    };
    // orgTenant is derived from the `org` param (preferred) or the single admin
    // org; key the effect on stable primitives (the raw param + the resolved
    // single-org id) rather than the fresh object to avoid a re-poll loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    routerState,
    sessionId,
    token,
    orgParam,
    adminOrgs.length === 1 ? adminOrgs[0].orgId : null,
  ]);

  // Neither in-app state nor a Stripe session id → nothing to confirm.
  if (!routerState && !sessionId) return <Navigate to="/upgrade" replace />;

  const workspacePath = session ? computeDefaultLanding(session) ?? '/' : '/';

  // Resolve display fields from whichever source we have.
  const planName = routerState?.planName ?? (sub ? PLAN_LABELS[sub.tier] ?? sub.tier : null);
  const seats = routerState?.seats ?? sub?.seatsPurchased ?? null;
  const annual =
    routerState?.annual ?? (sub?.billingCycle ? sub.billingCycle === 'annual' : null);
  const nextBilling = routerState?.currentPeriodEnd ?? sub?.currentPeriodEnd ?? null;

  return (
    <div className="max-w-lg mx-auto px-6 py-16 text-center">
      <div className="mb-6 inline-flex items-center justify-center w-14 h-14 rounded-full bg-status-success-bg">
        <span className="text-2xl text-status-success-text">✓</span>
      </div>

      <h1 className="text-2xl font-bold text-heading mb-2">
        {finalizing ? 'Finalizing your purchase…' : 'Your plan is now active.'}
      </h1>
      <p className="text-sm text-muted mb-8">
        {finalizing
          ? 'Payment received. We’re activating your plan — this only takes a moment.'
          : `Welcome${planName ? ` to ${planName}` : ''}. A receipt has been sent to your email.`}
      </p>

      {!finalizing && (
        <dl className="mb-8 rounded-lg border border-edge bg-surface/50 divide-y divide-edge text-left">
          {[
            ['Plan', planName ?? '—'],
            ['Seats', seats !== null ? String(seats) : '—'],
            ['Billing', annual === null ? '—' : annual ? 'Annual' : 'Monthly'],
            ['Next billing date', formatDate(nextBilling)],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between px-4 py-3 text-sm">
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium text-primary">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <button
        className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-white text-sm font-medium transition-colors"
        onClick={() => navigate(workspacePath)}
      >
        Go to workspace →
      </button>
    </div>
  );
}
