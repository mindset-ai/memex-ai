// spec-312 dec-4 — the "Your Journeys" pearls surface on Home.
//
// One row of pearls per journey: green for an earned step, grey for an unearned one.
// Pearl state is derived entirely from the user's real activity (the journey-state the
// server returns) — there is no separate stored journey-progress, so the same activity
// yields the same pearls across reloads and sessions. The surface is the permanent,
// escapable-but-never-erasable re-entry point: clicking a journey re-opens it.
//
// Built for N journeys; v0 ships with one (onboarding). The shape stays multi-row.

export interface JourneyPearl {
  id: string;
  label: string;
  attained: boolean;
}

export interface PearlJourney {
  id: string;
  title: string;
  steps: JourneyPearl[];
}

export function YourJourneys({
  journeys,
  onOpen,
}: {
  journeys: PearlJourney[];
  // Re-open a journey from its pearls (collapse is escapable; the pearls never vanish).
  onOpen: (journeyId: string) => void;
}) {
  if (journeys.length === 0) return null;
  return (
    <section data-testid="your-journeys" className="mx-auto mt-8 w-full max-w-3xl px-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Your journeys
      </h2>
      <ul className="flex flex-col gap-2">
        {journeys.map((j) => (
          <li key={j.id}>
            <button
              type="button"
              data-testid={`journey-pearls-${j.id}`}
              onClick={() => onOpen(j.id)}
              className="flex w-full items-center gap-3 rounded-lg border border-edge bg-panel px-4 py-3 text-left transition hover:border-accent/50"
            >
              <span className="flex-none text-sm font-medium text-heading">{j.title}</span>
              <span className="ml-auto flex items-center gap-1.5" aria-hidden>
                {j.steps.map((s) => (
                  <span
                    key={s.id}
                    title={s.label}
                    data-testid={`pearl-${j.id}-${s.id}`}
                    data-earned={s.attained ? 'true' : 'false'}
                    className={`h-2.5 w-2.5 flex-none rounded-full ${
                      s.attained ? 'bg-status-success-text' : 'bg-edge'
                    }`}
                  />
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
