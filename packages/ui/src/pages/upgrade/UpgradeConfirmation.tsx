import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../../components/AuthContext';
import { computeDefaultLanding } from '../../components/AuthContext';

interface ConfirmationState {
  planName: string;
  seats: number;
  annual: boolean;
  currentPeriodEnd: string;
}

function formatDate(iso: string): string {
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
  const { session } = useAuth();

  const state = location.state as ConfirmationState | null;

  if (!state) return <Navigate to="/upgrade" replace />;

  const { planName, seats, annual, currentPeriodEnd } = state;
  const workspacePath = session ? computeDefaultLanding(session) ?? '/': '/';

  return (
    <div className="max-w-lg mx-auto px-6 py-16 text-center">
      <div className="mb-6 inline-flex items-center justify-center w-14 h-14 rounded-full bg-status-success-bg">
        <span className="text-2xl text-status-success-text">✓</span>
      </div>

      <h1 className="text-2xl font-bold text-heading mb-2">Your plan is now active.</h1>
      <p className="text-sm text-muted mb-8">
        Welcome to {planName}. A receipt has been sent to your email.
      </p>

      <dl className="mb-8 rounded-lg border border-edge bg-surface/50 divide-y divide-edge text-left">
        {[
          ['Plan', planName],
          ['Seats', String(seats)],
          ['Billing', annual ? 'Annual' : 'Monthly'],
          ['Next billing date', formatDate(currentPeriodEnd)],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between px-4 py-3 text-sm">
            <dt className="text-muted">{label}</dt>
            <dd className="font-medium text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      <button
        className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-btn-primary hover:bg-btn-primary-hover text-white text-sm font-medium transition-colors"
        onClick={() => navigate(workspacePath)}
      >
        Go to workspace →
      </button>
    </div>
  );
}
