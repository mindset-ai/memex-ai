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

  // Tick once per second while cooling down. Keyed on the boolean (not the count) so a
  // single interval spans the whole window instead of being torn down and recreated on
  // every tick — the functional updater below needs nothing from the closure.
  const coolingDown = cooldown > 0;
  useEffect(() => {
    if (!coolingDown) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [coolingDown]);

  const resend = async () => {
    if (sending || cooldown > 0) return;
    setSending(true);
    setError(null);
    try {
      await resendVerificationApi(token);
      setSentAt(Date.now());
      setCooldown(RESEND_COOLDOWN_SEC);
    } catch (err) {
      // Drop any prior success so the green "Sent a new link" and a red error can't
      // render together.
      setSentAt(null);
      if (err instanceof AuthApiError) {
        setError(err.message);
        // A 429 can be either the 60s gap or the hourly cap (retryAfterSec up to
        // ~3600). Clamp the visible countdown to the normal window so we never show
        // an hour-long "Resend in 3599s"; the server still enforces the hourly cap,
        // so a later click just re-surfaces its "too many attempts" message.
        if (err.status === 429) {
          setCooldown(Math.min(err.retryAfterSec ?? RESEND_COOLDOWN_SEC, RESEND_COOLDOWN_SEC));
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
