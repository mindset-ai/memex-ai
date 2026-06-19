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

export function IdentityStep({
  preview = false,
  onComplete,
}: {
  // In operator preview the step is render-only (dec-8): Continue/Skip don't write.
  preview?: boolean;
  // Called after a successful save so the Home Canvas refetches journey-state and
  // advances past identity — otherwise the button would sit on "Saving…".
  onComplete?: () => void;
} = {}) {
  const { token, user, updateSession } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<RoleCoords>(CENTERED_ROLE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (coords: RoleCoords) => {
      if (preview) return; // operator preview is render-only — never write or freeze
      const trimmed = name.trim() || (user?.name ?? '').trim();
      if (!trimmed) {
        setError('Please tell us what to call you.');
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const session = await updateProfileApi(token, trimmed, coords);
        updateSession(session); // clears needsOnboarding
        onComplete?.(); // refetch journey-state so the canvas advances past identity
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      } finally {
        setSubmitting(false);
      }
    },
    [name, token, user, updateSession, preview, onComplete],
  );

  // Greeting tracks the live name field (not the stored SSO name) so the H1 updates
  // as the user edits their name.
  const greeting = firstName(name);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid="journey-step-identity"
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-12"
      >
        <div className="mb-5 font-mono text-xs lowercase tracking-tight text-muted">// 00 · who you are and what you do</div>
        <h1 className="text-3xl font-black tracking-tight text-heading sm:text-4xl">
          {greeting ? `Good to meet you, ${greeting}.` : 'Good to meet you.'}
        </h1>
        <p className="mt-3 text-secondary">
          That&apos;s the name from your login, swap it below if it&apos;s not quite you.
        </p>

        <label className="mt-6 block">
          <input
            data-testid="identity-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="w-full rounded-xl border border-edge bg-card px-3 py-2 text-primary outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>

        <div className="mt-6">
          <p className="text-secondary">
            {greeting ? `Now, ${greeting}, nobody's just one thing anymore` : "Nobody's just one thing anymore"}: not
            just a developer, not just a designer, not just a PM.
          </p>
          <span className="mt-2 mb-8 block text-sm font-medium text-secondary">
            Drag the dot to where you fit. Most people land somewhere in between.
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
