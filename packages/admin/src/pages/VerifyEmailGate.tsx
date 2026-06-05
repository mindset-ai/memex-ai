import { useState } from 'react';
import { useAuth } from '../components/AuthContext';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { resendVerificationApi, AuthApiError } from '../api/client';

// Shown for authenticated users whose emailVerified=false. They can't proceed into their
// Memex until they click the link in their inbox. Provides a resend button + sign out.
export function VerifyEmailGate() {
  const { session, token, logout } = useAuth();
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const email = session?.user.email ?? '';

  const resend = async () => {
    setSending(true);
    setError(null);
    try {
      await resendVerificationApi(token);
      setSentAt(Date.now());
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : 'Could not resend');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-heading">
            memex<span className="text-[#7b93b8]">.ai</span>
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
            <Button onClick={resend} disabled={sending} variant="secondary">
              {sending ? 'Sending…' : 'Resend email'}
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
