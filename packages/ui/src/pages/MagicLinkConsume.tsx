import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth, computeDefaultLanding } from '../components/AuthContext';
import { isFeatureHidden } from '../utils/featureFlags';
import { magicLinkConsumeApi, AuthApiError } from '../api/client';
import { Spinner } from '../components/Spinner';

type Stage = 'consuming' | 'success' | 'failed';

// Public page hit when the user clicks a magic-link sign-in email. Consumes the token,
// establishes a session, redirects into the app.
export function MagicLinkConsume() {
  const [params] = useSearchParams();
  const { acceptSession } = useAuth();
  const [stage, setStage] = useState<Stage>('consuming');
  const [error, setError] = useState<string | null>(null);
  // Single-use tokens + React StrictMode dev double-invoke = the second call always fails
  // with "already used". Guard with a ref so we only fire once per token.
  const startedFor = useRef<string | null>(null);

  const token = params.get('token');

  useEffect(() => {
    if (!token) {
      setStage('failed');
      setError('Missing sign-in token');
      return;
    }
    if (startedFor.current === token) return;
    startedFor.current = token;

    magicLinkConsumeApi(token)
      .then((session) => {
        acceptSession(session);
        setStage('success');
        // spec-421 dec-5: route through /login (whose element is RootRedirect) so the
        // onboarding-state landing decision applies — a returning engaged user lands on
        // their Specs board, a new user on /home. /login is a real SPA path (never the
        // apex `/`, which 301s to marketing). Fall back to the default tenant directly
        // only when 'home' is hidden per-env (mirrors RootRedirect's loop-avoidance).
        const landing = isFeatureHidden(session, 'home')
          ? (computeDefaultLanding(session) ?? '/login')
          : '/login';
        window.setTimeout(() => {
          window.location.href = landing;
        }, 400);
      })
      .catch((err) => {
        setStage('failed');
        setError(err instanceof AuthApiError ? err.message : 'Sign-in failed');
      });
  }, [token, acceptSession]);

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border border-edge bg-card p-6 text-center space-y-4">
        <h1 className="text-xl font-semibold text-heading">
          {stage === 'consuming' && 'Signing you in…'}
          {stage === 'success' && 'Signed in'}
          {stage === 'failed' && 'Could not sign in'}
        </h1>

        {stage === 'consuming' && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}

        {stage === 'failed' && (
          <>
            <p className="text-sm text-status-danger-text">{error}</p>
            <Link to="/" className="text-xs text-muted hover:text-secondary">
              ← Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
