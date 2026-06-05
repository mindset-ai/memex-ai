import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth, computeDefaultLanding } from '../components/AuthContext';
import { passwordResetConfirmApi, AuthApiError } from '../api/client';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';

// Public page hit when the user clicks a password-reset link. Shows a new-password form,
// POSTs to the confirm endpoint, then signs the user in with the returned session.
export function ResetPassword() {
  const [params] = useSearchParams();
  const { acceptSession } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const token = params.get('token');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError('Missing reset token');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const session = await passwordResetConfirmApi(token, password);
      acceptSession(session);
      setDone(true);
      const landing = computeDefaultLanding(session) ?? '/login';
      window.setTimeout(() => {
        window.location.href = landing;
      }, 800);
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : 'Reset failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-heading">
            memex<span className="text-[#7b93b8]">.ai</span>
          </h1>
        </div>

        <div className="rounded-xl border border-edge bg-card p-6 space-y-4">
          {done ? (
            <>
              <h2 className="text-base font-semibold text-heading">Password updated</h2>
              <p className="text-sm text-secondary">Redirecting you to your Memex…</p>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-heading">Set a new password</h2>
              <form onSubmit={submit} className="space-y-3">
                <label className="block">
                  <span className="block text-xs text-secondary mb-1">
                    New password <span className="text-muted">(min 10 chars)</span>
                  </span>
                  <Input
                    type="password"
                    required
                    minLength={10}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                <label className="block">
                  <span className="block text-xs text-secondary mb-1">Confirm</span>
                  <Input
                    type="password"
                    required
                    minLength={10}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
                {error && (
                  <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-xs text-status-danger-text">
                    {error}
                  </div>
                )}
                <Button
                  type="submit"
                  disabled={submitting || password.length < 10 || password !== confirm}
                  className="w-full"
                >
                  {submitting ? 'Updating…' : 'Set password'}
                </Button>
              </form>
              <Link to="/" className="block text-center text-xs text-muted hover:text-secondary">
                ← Back to sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
