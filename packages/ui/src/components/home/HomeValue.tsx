// spec-315 — the graduated home-of-value surface. Renders, top to bottom: "Where you're
// needed" then "Your specs" (the journey pearls live BELOW, relocated by HomeCanvas).
//
// "Your specs" reuses the Pulse HotSpecCard (one source of truth, dec-2/ac-10), fed from
// the ownership-tiered /api/me/home. The whole surface is LIVE: it polls every ~3s while
// the tab is visible, pausing when hidden and refetching on focus, for ≤4s freshness
// (ac-11). Each block collapses when empty; all-empty shows a coherent hub (ac-5).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchHomeApi,
  type HomeResponse,
  type HomeSpecCard,
  type WhereNeededItem,
} from '../../api/home';
import { HotSpecCard } from '../pulse/HotSpecs';
import { specState, type HotSpec, type Worker } from '../pulse/pulseDerive';
import type { ActorKind } from '../pulse/types';

const POLL_MS = 3000;

// A per-Memex provenance pill — the cross-Memex distinguisher.
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

// Build the props the Pulse card expects from our server-shaped card.
function toHotSpec(card: HomeSpecCard, now: number): HotSpec {
  const lastMs = card.lastActivityAnyMs;
  const ageMs = lastMs != null ? now - lastMs : null;
  return {
    docId: card.docId,
    score: 0, // heat ranking is unused on Home — we order server-side by ownership + my recency
    hasPresence: false,
    lastActivityMs: lastMs,
    ageMs,
    state: specState(false, ageMs),
  };
}

function toWorkers(card: HomeSpecCard): Worker[] {
  return card.involved
    .filter((w): w is HomeSpecCard['involved'][number] & { actorUserId: string } => w.actorUserId != null)
    .map((w) => ({
      key: `${w.actorUserId}:${w.actorKind}`,
      actorUserId: w.actorUserId,
      actorName: w.actorName,
      actorKind: w.actorKind as ActorKind,
      channel: 'rest_ui' as const,
      clientId: null,
      docId: card.docId,
      lastSeenMs: w.lastSeenMs,
      freshness: 'idle' as const,
    }));
}

function HomeSpecs({ specs }: { specs: HomeSpecCard[] }) {
  if (specs.length === 0) return null; // collapse when empty
  const now = Date.now();
  return (
    <section data-testid="home-specs" className="mt-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Your specs</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {specs.map((card) => (
          <div key={card.docId} data-testid={`home-spec-${card.docId}`} className="flex flex-col gap-1">
            <MemexPill name={card.memexName} />
            <HotSpecCard
              spec={toHotSpec(card, now)}
              involved={toWorkers(card)}
              handle={card.handle}
              title={card.title}
              phase={card.phase}
              narrative={card.narrative ?? undefined}
              health={card.health ?? undefined}
              spark={card.spark}
              specHref={() => card.path}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

// The coherent state when nothing needs the user and they own nothing recent (ac-5).
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

  // Live: load once, then poll every ~3s while the tab is visible (≤4s freshness, ac-11).
  // Pauses the network call while hidden; refetches immediately on focus / visibility-regain.
  useEffect(() => {
    let live = true;
    const load = () =>
      fetchHomeApi()
        .then((d) => {
          if (live) setData(d);
        })
        .catch(() => {
          // Never hard-crash the home; keep the last good data, or fall back to empty.
          if (live) setData((prev) => prev ?? { whereYoureNeeded: [], specs: [] });
        });

    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    const onActive = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onActive);
    window.addEventListener('focus', onActive);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onActive);
      window.removeEventListener('focus', onActive);
    };
  }, []);

  const whereNeeded = data?.whereYoureNeeded ?? [];
  const specs = data?.specs ?? [];
  const bothEmpty = data != null && whereNeeded.length === 0 && specs.length === 0;

  return (
    <section data-testid="home-of-value" className="mx-auto mt-8 w-full max-w-3xl px-4">
      <WhereYoureNeeded items={whereNeeded} />
      <HomeSpecs specs={specs} />
      {bothEmpty && <EmptyHub specsPath={specsPath} />}
    </section>
  );
}
