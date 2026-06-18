// spec-305 (dec-2/dec-4/dec-5) — the journey's identity step. We already know the
// user's name from SSO, so we CONFIRM it rather than ask cold, and we learn where
// they sit on the developer/designer/PM triangle. Submitting (or skipping to the
// centered default) persists the profile and stamps identity_confirmed_at, which
// clears needsOnboarding so the journey self-advances. Skippable, never a gate.
import { useCallback, useState } from 'react';
import { useAuth } from '../AuthContext';
import { updateProfileApi } from '../../api/client';
import { RoleTriangle, CENTERED_ROLE, personaLabel, type RoleCoords } from './RoleTriangle';

function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const f = name.trim().split(/\s+/)[0];
  return f || null;
}

export function IdentityStep() {
  const { token, user, updateSession } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<RoleCoords>(CENTERED_ROLE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (coords: RoleCoords) => {
      const trimmed = name.trim() || (user?.name ?? '').trim();
      if (!trimmed) {
        setError('Please tell us what to call you.');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const session = await updateProfileApi(token, trimmed, coords);
        updateSession(session); // clears needsOnboarding → the journey self-advances
      } catch (err) {
        setSubmitting(false);
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      }
    },
    [name, token, user, updateSession],
  );

  const greeting = firstName(user?.name);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid="journey-step-identity"
        className="relative w-full max-w-xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-10"
      >
        <h1 className="text-3xl font-black tracking-tight text-heading sm:text-4xl">
          {greeting ? `Good to meet you, ${greeting}.` : 'Good to meet you.'}
        </h1>
        <p className="mt-3 text-secondary">
          A couple of quick things, then we&apos;ll get you to your first win.
        </p>

        <label className="mt-6 block">
          <span className="mb-1 block text-sm font-medium text-secondary">
            We&apos;ll call you this — change it if you&apos;d rather.
          </span>
          <input
            data-testid="identity-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="w-full rounded-xl border border-edge bg-card px-3 py-2 text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>

        <div className="mt-6">
          <span className="mb-2 block text-sm font-medium text-secondary">
            Where do you sit? No one&apos;s just one thing — place yourself anywhere.
          </span>
          <RoleTriangle value={role} onChange={setRole} />
          <p data-testid="persona-label" className="mt-2 text-center text-sm font-semibold text-heading">
            {personaLabel(role)}
          </p>
        </div>

        {error && (
          <div
            data-testid="identity-error"
            className="mt-4 rounded-lg border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger-text"
          >
            {error}
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="identity-continue"
            disabled={submitting}
            onClick={() => submit(role)}
            className="inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(96deg,#8b5cf6,#6366f1)] px-5 py-3 text-sm font-bold text-white shadow-lg transition hover:brightness-110 disabled:opacity-60"
          >
            {submitting ? 'Saving…' : 'Continue'}
            <span aria-hidden>→</span>
          </button>
          <button
            type="button"
            data-testid="identity-skip"
            disabled={submitting}
            onClick={() => submit(CENTERED_ROLE)}
            className="rounded-xl border border-edge px-4 py-3 text-sm font-semibold text-secondary transition hover:bg-card-hover hover:text-primary disabled:opacity-60"
          >
            Skip for now
          </button>
        </div>
      </article>
    </div>
  );
}
