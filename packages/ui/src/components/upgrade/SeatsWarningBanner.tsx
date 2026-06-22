import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { fetchCurrentSubscription } from '../../api/client';
import { tenantBase } from '../../api/http';

export function SeatsWarningBanner() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [warning, setWarning] = useState<{ purchased: number; active: number } | null>(null);

  useEffect(() => {
    // Only fetch when in a tenant context (tenantBase returns non-null)
    if (!token || !tenantBase()) return;
    fetchCurrentSubscription(token)
      .then((sub) => setWarning(sub.seatsWarning))
      .catch(() => { /* non-fatal */ });
  }, [token]);

  if (!warning) return null;

  return (
    <div className="px-4 py-2 bg-status-warning-bg border-b border-status-warning-border text-status-warning-text text-xs flex items-center justify-between gap-4">
      <span>
        Your org has <strong>{warning.active}</strong> active members but only{' '}
        <strong>{warning.purchased}</strong> seats purchased.
      </span>
      <button
        className="shrink-0 underline font-medium hover:no-underline"
        onClick={() => navigate('/org?tab=billing')}
      >
        Add seats →
      </button>
    </div>
  );
}
