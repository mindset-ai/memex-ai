import { useCallback, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { useAuth } from '../components/AuthContext';
import { Logo } from '../components/Logo';
import { updateProfileApi } from '../api/client';

export function Onboarding() {
  const { token, user, updateSession } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) return;
      setSubmitting(true);
      setError(null);
      try {
        const session = await updateProfileApi(token, trimmed);
        updateSession(session);
      } catch (err) {
        setSubmitting(false);
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      }
    },
    [name, token, updateSession]
  );

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-heading mb-2 flex justify-center">
            <Logo className="h-7" />
          </h1>
          <p className="text-sm text-secondary">Welcome! Let's set up your profile.</p>
        </div>

        <form onSubmit={onSubmit} className="p-6 rounded-xl border border-edge bg-card space-y-4">
          <label className="block">
            <span className="block text-sm text-secondary mb-1">What's your name?</span>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your display name"
              maxLength={100}
            />
          </label>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? 'Saving…' : 'Continue'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
