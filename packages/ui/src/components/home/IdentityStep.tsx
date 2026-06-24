// spec-336 — step 0 "About you" (v2). Full-width: a warm greeting, the role triangle
// beside a live persona title/description, and Continue. We already know the user's name
// from SSO (no name field — spec-336 dec / ac-2: reuse the captured profile, don't persist
// a second copy); Continue saves their role placement (role_coords) which both confirms
// identity (clears needsOnboarding) and drives the persona branch (builder vs non-builder).
import { useCallback, useState } from 'react';
import { useAuth } from '../AuthContext';
import { updateProfileApi } from '../../api/client';
import { RoleTriangle, CENTERED_ROLE, personaLabel, personaDescription, personaPromise, type RoleCoords } from './RoleTriangle';

function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const f = name.trim().split(/\s+/)[0];
  return f || null;
}

export function IdentityStep({
  preview = false,
  onComplete,
  onCtaClick,
  onPersonaSelected,
}: {
  preview?: boolean;
  onComplete?: () => void;
  onCtaClick?: (target: string) => void;
  // spec-372 dec-6 Layer C — emit home_canvas.persona_selected with the RESOLVED label.
  onPersonaSelected?: (persona: string) => void;
} = {}) {
  const { token, user, updateSession } = useAuth();
  const [role, setRole] = useState<RoleCoords>(CENTERED_ROLE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SSO sign-ins arrive with a name we reuse as-is — no editable field, no second copy
  // (ac-2). Native email sign-ups arrive NAMELESS, so for them — and only them — the
  // identity step captures the name here. It's the first capture, not a duplicate.
  const ssoName = (user?.name ?? '').trim();
  const needsName = ssoName === '';
  const [name, setName] = useState(ssoName);

  const greeting = firstName(user?.name);

  const submit = useCallback(
    async (coords: RoleCoords) => {
      if (preview) return; // operator preview is render-only — never write
      const finalName = name.trim();
      if (needsName && !finalName) return; // guard — Continue is also disabled until named
      onCtaClick?.('submit_identity');
      setSubmitting(true);
      setError(null);
      try {
        const session = await updateProfileApi(token, finalName, coords);
        updateSession(session); // clears needsOnboarding
        // spec-372 dec-6 — the persona is confirmed; record the resolved label (never coords).
        onPersonaSelected?.(personaLabel(coords));
        onComplete?.(); // refetch journey-state so the canvas advances past identity
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      } finally {
        setSubmitting(false);
      }
    },
    [token, name, needsName, updateSession, preview, onComplete, onCtaClick],
  );

  return (
    <div data-testid="journey-step-identity" className="animate-[fadeIn_0.4s_ease]">
      {/* spec-372 t-13 — v3 greeting is medium weight with a wider gap to the heading. */}
      <p className="mb-6 text-base font-medium text-muted">
        {greeting ? `Hi ${greeting}, welcome to Memex AI.` : 'Welcome to Memex AI.'}
      </p>
      <h2 className="onboarding-heading mb-3.5">
        Built around how you work
      </h2>
      <p className="mb-1.5 max-w-3xl text-lg leading-relaxed text-secondary">
        Let&apos;s tailor this to how you actually work.
      </p>
      <p className="mb-6 max-w-3xl text-lg leading-relaxed text-secondary">
        Most people on a modern product team do more than one job. Where do you spend most of your time?
      </p>

      {needsName && (
        <div className="mb-6 max-w-sm">
          <label htmlFor="identity-name" className="mb-1.5 block text-sm font-semibold text-secondary">
            Your name
          </label>
          <input
            id="identity-name"
            data-testid="identity-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="How should we address you?"
            className="w-full rounded-xl border border-edge bg-surface px-4 py-3 text-base text-primary outline-hidden transition focus:border-accent"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-12 gap-y-6">
        <div className="w-full max-w-md flex-none">
          <RoleTriangle value={role} onChange={setRole} />
        </div>
        <div className="min-w-[16rem] flex-1">
          {/* spec-372 t-12 — v3 "So you're a…" eyebrow + the semibold role title (was font-black). */}
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">So you&apos;re a…</div>
          <div
            data-testid="persona-label"
            className="text-[23px] font-semibold leading-tight tracking-[-0.01em] text-heading"
          >
            {personaLabel(role)}
          </div>
          <p data-testid="persona-description" className="mt-2.5 max-w-md text-lg leading-relaxed text-secondary">
            {personaDescription(role)}
          </p>

          {/* spec-372 t-5 (change #10) — the persona-keyed "With Memex we promise" card,
              copy verbatim from v3, switching live with the dominant vertex. */}
          <div data-testid="persona-promise" className="mt-6 max-w-md rounded-2xl bg-surface/60 p-5">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">With Memex we promise</div>
            <p className="mb-2 text-base font-bold leading-snug text-heading">{personaPromise(role).head}</p>
            <p className="text-sm leading-relaxed text-secondary">{personaPromise(role).detail}</p>
          </div>

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
            disabled={submitting || (needsName && !name.trim())}
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
