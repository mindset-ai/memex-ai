// spec-312 dec-2 — the home-of-value surface.
//
// This is the real "home of value" that is ALWAYS the page: it renders for every user
// regardless of journey-graduation state (the journey is a layer on top, not a gate in
// front). spec-312 owns this SURFACE and the graduated-vs-not branch; the richer
// content design of the graduated home is separate, later work — so this is a modest
// but real surface (a heading plus the primary way back into work), not a placeholder.

export function HomeValue({ specsPath }: { specsPath: string | null }) {
  return (
    <section
      data-testid="home-of-value"
      className="mx-auto mt-8 w-full max-w-3xl px-4"
    >
      <h2 className="text-lg font-semibold text-heading">Your work hub</h2>
      <p className="mt-1 text-sm text-secondary">
        Everything you are building, in one place. Pick up where you left off.
      </p>
      {specsPath && (
        <a
          href={specsPath}
          data-testid="home-value-specs"
          className="mt-3 inline-flex items-center rounded-lg border border-edge bg-panel px-4 py-2 text-sm font-medium text-heading transition hover:border-accent/50"
        >
          Open your Specs board
        </a>
      )}
    </section>
  );
}
