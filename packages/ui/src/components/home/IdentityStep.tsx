// spec-336 — step 0 "About you" (v2). Full-width: a warm greeting, the role triangle
// beside a live persona title/description, and Continue. We already know the user's name
// from SSO (no name field — spec-336 dec / ac-2: reuse the captured profile, don't persist
// a second copy); Continue saves their role placement (role_coords) which both confirms
// identity (clears needsOnboarding) and drives the persona branch (builder vs non-builder).
import { useCallback, useState } from 'react';
import { useAuth } from '../AuthContext';
import { updateProfileApi } from '../../api/client';
import { RoleTriangle, CENTERED_ROLE, personaLabel, personaDescription, type RoleCoords } from './RoleTriangle';

function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const f = name.trim().split(/\s+/)[0];
  return f || null;
}

export function IdentityStep({
  preview = false,
  onComplete,
  onCtaClick,
}: {
  preview?: boolean;
  onComplete?: () => void;
  onCtaClick?: (target: string) => void;
} = {}) {
  const { token, user, updateSession } = useAuth();
  const [role, setRole] = useState<RoleCoords>(CENTERED_ROLE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const greeting = firstName(user?.name);

  const submit = useCallback(
    async (coords: RoleCoords) => {
      if (preview) return; // operator preview is render-only — never write
      onCtaClick?.('submit_identity');
      const name = (user?.name ?? '').trim();
      setSubmitting(true);
      setError(null);
      try {
        const session = await updateProfileApi(token, name, coords);
        updateSession(session); // clears needsOnboarding
        onComplete?.(); // refetch journey-state so the canvas advances past identity
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      } finally {
        setSubmitting(false);
      }
    },
    [token, user, updateSession, preview, onComplete, onCtaClick],
  );

  return (
    <div data-testid="journey-step-identity" className="animate-[fadeIn_0.4s_ease]">
      <p className="mb-2.5 text-base font-semibold text-muted">
        {greeting ? `Hi ${greeting}, welcome to Memex.` : 'Welcome to Memex.'}
      </p>
      <h2 className="mb-3.5 text-4xl font-black leading-[1.1] tracking-tight text-heading">
        Built around how you work.
      </h2>
      <p className="mb-1.5 max-w-3xl text-lg leading-relaxed text-secondary">
        A quick read on you and your stack — we&apos;ll tailor the next few steps to exactly what you need.
      </p>
      <p className="mb-1.5 max-w-3xl leading-relaxed text-secondary">
        {greeting ? `Now, ${greeting}, nobody's just one thing anymore` : "Nobody's just one thing anymore"}: not just a
        developer, not just a designer, not just a PM.
      </p>
      <p className="mb-6 mt-4 max-w-3xl leading-relaxed text-muted">
        Drag the dot to where you fit. Most people land somewhere in between.
      </p>

      <div className="flex flex-wrap items-center gap-x-12 gap-y-6">
        <div className="w-full max-w-md flex-none">
          <RoleTriangle value={role} onChange={setRole} />
        </div>
        <div className="min-w-[16rem] flex-1">
          <div data-testid="persona-label" className="text-3xl font-black tracking-tight text-heading">
            {personaLabel(role)}
          </div>
          <p data-testid="persona-description" className="mt-2.5 max-w-md text-lg leading-relaxed text-secondary">
            {personaDescription(role)}
          </p>

          {error && (
            <div
              data-testid="identity-error"
              className="mt-4 rounded-lg border border-status-danger-border bg-status-danger-bg px-3 py-2 text-sm text-status-danger-text"
            >
              {error}
            </div>
          )}

          <button
            type="button"
            data-testid="identity-continue"
            disabled={submitting}
            onClick={() => submit(role)}
            className="mt-7 inline-flex items-center gap-2 rounded-xl bg-accent px-6 py-3.5 text-base font-bold text-on-accent shadow-lg transition hover:bg-accent-hover disabled:opacity-60"
          >
            {submitting ? 'Saving…' : 'Continue'}
            <span aria-hidden>→</span>
          </button>
        </div>
      </div>
    </div>
  );
}
