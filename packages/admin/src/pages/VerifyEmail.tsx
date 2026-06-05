import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth, computeDefaultLanding } from '../components/AuthContext';
import { verifyEmailApi, AuthApiError } from '../api/client';
import { Spinner } from '../components/Spinner';
import { Confetti } from '../components/Confetti';
import { Button } from '../components/ui/Button';

type Stage = 'verifying' | 'success' | 'failed';

// Public page hit when the user clicks the link in their verification email.
// Consumes the token, stamps email_verified_at server-side, stores the refreshed
// session + new JWT client-side, and shows a celebratory success state.
export function VerifyEmail() {
  const [params] = useSearchParams();
  const { acceptSession, session } = useAuth();
  const [stage, setStage] = useState<Stage>('verifying');
  const [error, setError] = useState<string | null>(null);
  // Guard against React StrictMode's double-invoke in dev: tokens are single-use, so two
  // calls turn the second into "Token has already been used" and flash the user a failure.
  const startedFor = useRef<string | null>(null);

  const token = params.get('token');

  useEffect(() => {
    if (!token) {
      setStage('failed');
      setError('Missing verification token');
      return;
    }
    if (startedFor.current === token) return;
    startedFor.current = token;

    verifyEmailApi(token)
      .then((s) => {
        acceptSession(s);
        setStage('success');
      })
      .catch((err) => {
        setStage('failed');
        setError(err instanceof AuthApiError ? err.message : 'Verification failed');
      });
  }, [token, acceptSession]);

  if (stage === 'success') {
    // After verification the session is set client-side; compute the user's
    // home (`/<ns>/<mx>/specs`) so the Continue button skips the apex `/`
    // (which 301s to www.memex.ai marketing per b-9 dec-2).
    const landing = session ? computeDefaultLanding(session) : null;
    return <VerifySuccess email={session?.user.email} landing={landing} />;
  }

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border border-edge bg-card p-6 text-center space-y-4">
        <h1 className="text-xl font-semibold text-heading">
          {stage === 'verifying' && 'Verifying your email…'}
          {stage === 'failed' && 'Verification failed'}
        </h1>

        {stage === 'verifying' && (
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

function VerifySuccess({ email, landing }: { email?: string; landing: string | null }) {
  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <Confetti />
      <div className="max-w-md w-full rounded-2xl border border-edge bg-card p-8 text-center space-y-5 relative z-10 shadow-lg">
        <div className="mx-auto w-16 h-16 rounded-full bg-status-success-bg border border-status-success-border flex items-center justify-center">
          <svg
            className="w-8 h-8 text-status-success-text"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-heading tracking-tight">
            You're all set!
          </h1>
          <p className="text-sm text-secondary">
            {email ? (
              <>
                <span className="text-primary">{email}</span> is verified. Welcome to
                memex<span className="text-[#7b93b8]">.ai</span>.
              </>
            ) : (
              <>
                Your email is verified. Welcome to memex
                <span className="text-[#7b93b8]">.ai</span>.
              </>
            )}
          </p>
        </div>

        <Button
          onClick={() => {
            // Land on the user's namespace home, not the apex (which 301s to www).
            window.location.href = landing ?? '/login';
          }}
          className="w-full"
        >
          Continue to your Memex
        </Button>
      </div>
    </div>
  );
}
