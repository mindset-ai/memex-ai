// spec-303 — the generic presentational shell for a journey step. Journey-agnostic:
// it renders any JourneyStepView (the engine picks which one). Theme-aware via the
// app's design tokens, with an accent splash for the headline + primary CTA.
import type { JourneyCta, JourneyStepView } from '../../journeys/types';

export function JourneyStepShell({
  view,
  userName,
  onCta,
}: {
  view: JourneyStepView;
  userName: string | null;
  onCta: (cta: JourneyCta) => void;
}) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid={`journey-step-${view.id}`}
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-12"
      >
        {view.eyebrow && (
          <div className="mb-5 font-mono text-xs lowercase tracking-tight text-muted">
            {view.eyebrow}
          </div>
        )}

        {userName &&
          (view.greetingHeading ? (
            <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
              Hello, <span className="text-heading">{userName}</span>.
            </h1>
          ) : (
            <p className="mb-3 text-lg font-medium text-secondary">
              Hello, <span className="font-semibold text-heading">{userName}</span>.
            </p>
          ))}

        <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
          {view.headline}
        </h1>

        {view.sub && <p className="mt-4 text-lg font-semibold text-primary">{view.sub}</p>}

        {view.body && (
          <p className="mt-4 max-w-prose leading-relaxed text-secondary">{view.body}</p>
        )}

        {view.memoriam && view.memoriam.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted">
              In loving memory of
            </span>
            {view.memoriam.map((m) => (
              <span
                key={m}
                className="rounded-md border border-edge bg-card-hover px-2 py-1 font-mono text-xs text-muted line-through decoration-[#fb5b78] decoration-2"
              >
                {m}
              </span>
            ))}
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="journey-cta-primary"
            onClick={() => onCta(view.primary)}
            className="inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(96deg,#8b5cf6,#6366f1)] px-5 py-3 text-sm font-bold text-white shadow-lg transition hover:brightness-110"
          >
            {view.primary.label}
            <span aria-hidden>→</span>
          </button>
          {view.secondary && (
            <button
              type="button"
              data-testid="journey-cta-secondary"
              onClick={() => onCta(view.secondary as JourneyCta)}
              className="rounded-xl border border-edge px-4 py-3 text-sm font-semibold text-secondary transition hover:bg-card-hover hover:text-primary"
            >
              {view.secondary.label}
            </button>
          )}
        </div>
      </article>
    </div>
  );
}
