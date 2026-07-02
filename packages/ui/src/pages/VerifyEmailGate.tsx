import { useEffect, useState } from 'react';
import { useAuth } from '../components/AuthContext';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { Logo } from '../components/Logo';
import { resendVerificationApi, AuthApiError } from '../api/client';

// Matches the server-side resend cooldown (auth-rate-limit resendVerificationCooldown).
const RESEND_COOLDOWN_SEC = 60;

// Shown for authenticated users whose emailVerified=false. They can't proceed into their
// Memex until they click the link in their inbox. Provides a resend button + sign out.
export function VerifyEmailGate() {
  const { session, token, logout } = useAuth();
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Seconds remaining before another resend is allowed. A visible cooldown so an
  // impatient user can't fire several sends in a row — the client half of the fix for
  // the duplicate-verification-email bug (the server enforces the same 60s gap).
  const [cooldown, setCooldown] = useState(0);

  const email = session?.user.email ?? '';

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const resend = async () => {
    if (sending || cooldown > 0) return;
    setSending(true);
    setError(null);
    try {
      await resendVerificationApi(token);
      setSentAt(Date.now());
      setCooldown(RESEND_COOLDOWN_SEC);
    } catch (err) {
      if (err instanceof AuthApiError) {
        setError(err.message);
        // Honor a server 429 (e.g. the page was reloaded mid-cooldown): start the
        // countdown from the server's retryAfterSec so the button stays disabled.
        if (err.status === 429 && err.retryAfterSec) {
          setCooldown(err.retryAfterSec);
        }
      } else {
        setError('Could not resend');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-heading flex justify-center">
            <Logo className="h-7" />
          </h1>
        </div>

        <div className="rounded-xl border border-edge bg-card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-heading">Confirm your email</h2>
          <p className="text-sm text-secondary">
            We sent a confirmation link to <strong className="text-primary">{email}</strong>.
            Click the link in that email to finish setting up your Memex.
          </p>

          {sentAt && <Alert variant="success">Sent a new link. Check your inbox.</Alert>}
          {error && <Alert variant="danger">{error}</Alert>}

          <div className="flex items-center gap-2">
            <Button onClick={resend} disabled={sending || cooldown > 0} variant="secondary">
              {sending ? 'Sending…' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend email'}
            </Button>
            <button
              onClick={logout}
              className="text-xs text-muted hover:text-secondary ml-auto"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
