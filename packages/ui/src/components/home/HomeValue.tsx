// spec-315 — the graduated home-of-value surface. Renders the two derived blocks
// (dec-3), top to bottom: "Where you're needed" then "Your specs in flight". The
// journey pearls live BELOW this surface (HomeCanvas relocates them, dec-3).
//
// Each block COLLAPSES when empty (no placeholder); when BOTH are empty the surface
// shows a single coherent "work hub" state (ac-5), never a blank page. No relevance
// ranking anywhere — order is the server's recency/assignment order (ac-4).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchHomeApi,
  type HomeResponse,
  type SpecInFlight,
  type WhereNeededItem,
} from '../../api/home';

// A per-Memex provenance pill — the cross-Memex distinguisher (dec-2/dec-3).
function MemexPill({ name }: { name: string }) {
  return (
    <span
      data-testid="memex-pill"
      className="inline-flex flex-none items-center rounded-full border border-edge bg-surface px-1.5 py-0.5 text-[11px] font-medium leading-none text-secondary"
    >
      {name}
    </span>
  );
}

function WhereYoureNeeded({ items }: { items: WhereNeededItem[] }) {
  if (items.length === 0) return null; // collapse when empty
  return (
    <section data-testid="home-where-needed" className="mt-2">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Where you&apos;re needed
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((it) => (
          <li key={it.commentId}>
            <Link
              to={it.path}
              data-testid={`where-needed-${it.commentId}`}
              className="flex items-center gap-3 rounded-lg border border-edge bg-panel px-4 py-3 transition hover:border-accent/50"
            >
              <span
                data-testid="where-needed-kind"
                className="flex-none rounded-full bg-status-info-bg px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none text-status-info-text"
              >
                {it.kind === 'assignment' ? 'Assigned' : 'Mention'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-heading">{it.snippet}</span>
                <span className="block truncate text-xs text-muted">{it.specTitle}</span>
              </span>
              <MemexPill name={it.memexName} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SpecsInFlight({ items, specsPath }: { items: SpecInFlight[]; specsPath: string | null }) {
  if (items.length === 0) return null; // collapse when empty
  return (
    <section data-testid="home-specs-in-flight" className="mt-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Your specs in flight
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((s) => (
          <li key={s.docId}>
            <Link
              to={s.path}
              data-testid={`spec-in-flight-${s.docId}`}
              className="flex items-center gap-3 rounded-lg border border-edge bg-panel px-4 py-3 transition hover:border-accent/50"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-heading">
                {s.title}
              </span>
              <MemexPill name={s.memexName} />
            </Link>
          </li>
        ))}
      </ul>
      {specsPath && (
        <Link
          to={specsPath}
          data-testid="specs-in-flight-see-all"
          className="mt-3 inline-block text-xs font-medium text-accent hover:text-accent-hover"
        >
          See all your specs
        </Link>
      )}
    </section>
  );
}

// The coherent state when the user has nothing pulling them in and nothing in flight
// (ac-5) — never a blank page.
function EmptyHub({ specsPath }: { specsPath: string | null }) {
  return (
    <section data-testid="home-empty">
      <h2 className="text-lg font-semibold text-heading">Your work hub</h2>
      <p className="mt-1 text-sm text-secondary">
        Nothing needs you right now. When a colleague tags you or you pick up a spec, it
        shows here.
      </p>
      {specsPath && (
        <Link
          to={specsPath}
          data-testid="home-value-specs"
          className="mt-3 inline-flex items-center rounded-lg border border-edge bg-panel px-4 py-2 text-sm font-medium text-heading transition hover:border-accent/50"
        >
          Open your Specs board
        </Link>
      )}
    </section>
  );
}

export function HomeValue({ specsPath }: { specsPath: string | null }) {
  const [data, setData] = useState<HomeResponse | null>(null);

  useEffect(() => {
    let live = true;
    fetchHomeApi()
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        // Never hard-crash the home on a fetch blip — fall back to the coherent hub.
        if (live) setData({ whereYoureNeeded: [], specsInFlight: [] });
      });
    return () => {
      live = false;
    };
  }, []);

  const whereNeeded = data?.whereYoureNeeded ?? [];
  const specs = data?.specsInFlight ?? [];
  const bothEmpty = data != null && whereNeeded.length === 0 && specs.length === 0;

  return (
    <section data-testid="home-of-value" className="mx-auto mt-8 w-full max-w-3xl px-4">
      <WhereYoureNeeded items={whereNeeded} />
      <SpecsInFlight items={specs} specsPath={specsPath} />
      {bothEmpty && <EmptyHub specsPath={specsPath} />}
    </section>
  );
}
