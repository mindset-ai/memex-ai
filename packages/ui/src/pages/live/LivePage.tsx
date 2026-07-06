// spec-458 — the public memex.ai/live proof-of-life page: headline counters
// (floor-gated three-tier cascade, dec-1/dec-5), an anonymized templated
// ticker, a world map where recent activity glows and fades (dec-7/dec-8) with
// periodic nearest-city callouts (dec-13), all UNLISTED (dec-4: noindex, no
// inbound links).
//
// Rendered fully public (outside AuthProvider — the /share pattern). Polls the
// public GET /api/live aggregate every 15s (dec-10); the display floor and map
// window come from the server's payload `config` (env-tunable, dec-1/dec-2).
//
// Dev/tuning knobs (not shipped affordances):
//   ?demo=1     client-side synthetic payload — previews the at-scale look
//               (loudly labelled; never real data)
//   ?floor=N    overrides the server floor for tuning

import { useEffect, useMemo, useRef, useState } from 'react';
import { LAND_DOTS, WORLD_GRID, projectToGrid } from './worldDots';
import { selectHeadline } from './headline';
import { nearestCity } from './cities';

interface TickerEntry {
  text: string;
  actorKind: 'human' | 'agent';
  at: string;
}
interface MapPoint {
  lat: number;
  lng: number;
  kind: 'human' | 'agent';
  weight: number;
}
interface LiveStats {
  now: { humans: number; agents: number };
  lastHour: { actors: number; events: number };
  totals: {
    specsCreatedThisWeek: number;
    decisionsResolvedThisWeek: number;
    acsCreatedThisWeek: number;
    toolCallsToday: number;
    eventsToday: number;
  };
  ticker: TickerEntry[];
  points: MapPoint[];
  geoSource: 'header' | 'demo' | 'none';
  config: { headcountFloor: number; mapWindowHours: number };
  generatedAt: string;
}

const POLL_MS = 15_000;

// ── Demo payload (?demo=1) — synthetic, client-side, clearly labelled ────────

const DEMO_TICKER_SEEDS: Array<[string, 'human' | 'agent']> = [
  ['an agent just resolved a decision', 'agent'],
  ['someone just created a spec', 'human'],
  ['an agent just moved a task forward', 'agent'],
  ['an agent just created an acceptance criterion', 'agent'],
  ['someone just updated a spec section', 'human'],
  ['an agent just updated a standard clause', 'agent'],
  ['someone just resolved a decision', 'human'],
  ['an agent just created a spec', 'agent'],
];

function demoStats(): LiveStats {
  const rand = mulberry32(Math.floor(Date.now() / POLL_MS));
  const points: MapPoint[] = [];
  for (let i = 0; i < 90; i++) {
    // Scatter across plausible population bands.
    const lat = -40 + rand() * 100;
    const lng = -160 + rand() * 320;
    points.push({
      lat,
      lng,
      kind: rand() > 0.35 ? 'agent' : 'human',
      weight: 0.2 + rand() * 0.8,
    });
  }
  const nowIso = new Date().toISOString();
  return {
    now: { humans: 118 + Math.floor(rand() * 20), agents: 342 + Math.floor(rand() * 40) },
    lastHour: { actors: 611, events: 4823 },
    totals: {
      specsCreatedThisWeek: 214,
      decisionsResolvedThisWeek: 890,
      acsCreatedThisWeek: 1204,
      toolCallsToday: 18760,
      eventsToday: 9421,
    },
    config: { headcountFloor: 25, mapWindowHours: 24 },
    ticker: Array.from({ length: 12 }, (_, i) => {
      const [text, actorKind] = DEMO_TICKER_SEEDS[Math.floor(rand() * DEMO_TICKER_SEEDS.length)];
      return { text, actorKind, at: new Date(Date.now() - i * 40_000).toISOString() };
    }),
    points,
    geoSource: 'demo',
    generatedAt: nowIso,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Data hook ────────────────────────────────────────────────────────────────

function useLiveStats(demo: boolean): { stats: LiveStats | null; error: boolean } {
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (demo) {
        if (!cancelled) setStats(demoStats());
        return;
      }
      try {
        const res = await fetch('/api/live');
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as LiveStats;
        if (!cancelled) {
          setStats(data);
          setError(false);
        }
      } catch {
        // Keep last-known stats on transient failure (usePresence posture).
        if (!cancelled) setError(true);
      }
    }
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [demo]);

  return { stats, error };
}

// ── Animated counter ─────────────────────────────────────────────────────────

function useAnimatedNumber(target: number): number {
  const [value, setValue] = useState(target);
  const raf = useRef<number>(0);
  useEffect(() => {
    const from = value;
    const delta = target - from;
    if (delta === 0) return;
    const start = performance.now();
    const DURATION = 900;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / DURATION);
      const eased = 1 - (1 - p) ** 3;
      setValue(Math.round(from + delta * eased));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return value;
}

// ── World map ────────────────────────────────────────────────────────────────

const CELL = 7; // svg units per grid cell
const MAP_W = WORLD_GRID.cols * CELL;
const MAP_H = WORLD_GRID.rows * CELL;

// dec-13 (ac-21): the periodic city callout. Every ~4.2s spotlight a random
// visible dot (never the same one twice in a row) with its nearest-city name +
// flag, derived at render time from the dot's public coarse coords. The label
// fades in and out via an SVG animate keyed per pick.
const SPOTLIGHT_MS = 4_200;

function WorldMap({ points }: { points: MapPoint[] }) {
  const activity = useMemo(
    () =>
      points.map((p, i) => {
        const [c, r] = projectToGrid(p.lat, p.lng);
        return {
          x: c * CELL,
          y: r * CELL,
          lat: p.lat,
          lng: p.lng,
          kind: p.kind,
          weight: p.weight,
          key: i,
        };
      }),
    [points],
  );

  const [spot, setSpot] = useState<{ index: number; tick: number } | null>(null);
  useEffect(() => {
    if (activity.length === 0) {
      setSpot(null);
      return;
    }
    let tick = 0;
    const pick = () => {
      tick += 1;
      setSpot((prev) => {
        if (activity.length === 1) return { index: 0, tick };
        let index = Math.floor(Math.random() * activity.length);
        if (prev && index === prev.index) index = (index + 1) % activity.length;
        return { index, tick };
      });
    };
    pick();
    const id = setInterval(pick, SPOTLIGHT_MS);
    return () => clearInterval(id);
  }, [activity]);

  const spotlight = useMemo(() => {
    if (!spot || !activity[spot.index]) return null;
    const dot = activity[spot.index];
    const city = nearestCity(dot.lat, dot.lng);
    // Edge-clamp: anchor away from the nearer horizontal edge; flip below the
    // dot near the top edge.
    const anchorEnd = dot.x > MAP_W * 0.72;
    const above = dot.y > 34;
    return {
      ...dot,
      label: city.flag ? `${city.name} ${city.flag}` : city.name,
      textAnchor: (anchorEnd ? 'end' : 'start') as 'end' | 'start',
      dx: anchorEnd ? -10 : 10,
      dy: above ? -12 : 26,
      tick: spot.tick,
    };
  }, [spot, activity]);

  return (
    <svg
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      className="w-full h-auto"
      role="img"
      aria-label="World map of recent Memex activity"
    >
      {LAND_DOTS.map(([c, r]) => (
        <circle
          key={`${c}-${r}`}
          cx={c * CELL + CELL / 2}
          cy={r * CELL + CELL / 2}
          r={1.6}
          fill="#334155"
        />
      ))}
      {activity.map((p) => (
        <g key={p.key} opacity={0.25 + p.weight * 0.75}>
          <circle
            cx={p.x}
            cy={p.y}
            r={3 + p.weight * 3}
            fill={p.kind === 'agent' ? '#a78bfa' : '#38bdf8'}
            opacity={0.18}
          >
            <animate
              attributeName="r"
              values={`${3 + p.weight * 3};${6 + p.weight * 4};${3 + p.weight * 3}`}
              dur={`${2.4 + (p.key % 5) * 0.4}s`}
              repeatCount="indefinite"
            />
          </circle>
          <circle cx={p.x} cy={p.y} r={2} fill={p.kind === 'agent' ? '#a78bfa' : '#38bdf8'} />
        </g>
      ))}
      {/* CSS (not SMIL) animation: SMIL begin-times are document-relative, so a
          group mounted mid-session would start "already finished" and freeze
          invisible. A CSS animation restarts on every keyed remount. */}
      <style>{`@keyframes live-spotlight{0%{opacity:0}15%{opacity:1}80%{opacity:1}100%{opacity:0}}`}</style>
      {spotlight && (
        <g
          key={`spot-${spotlight.tick}`}
          style={{ opacity: 0, animation: `live-spotlight ${SPOTLIGHT_MS / 1000}s ease forwards` }}
        >
          <circle
            cx={spotlight.x}
            cy={spotlight.y}
            r={7}
            fill="none"
            stroke={spotlight.kind === 'agent' ? '#a78bfa' : '#38bdf8'}
            strokeWidth={1.5}
          />
          <text
            x={spotlight.x + spotlight.dx}
            y={spotlight.y + spotlight.dy}
            textAnchor={spotlight.textAnchor}
            fontSize={22}
            fontWeight={600}
            fill="#e2e8f0"
            stroke="#020617"
            strokeWidth={5}
            paintOrder="stroke"
          >
            {spotlight.label}
          </text>
        </g>
      )}
    </svg>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins === 0) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} mins ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function Stat({ value, label }: { value: number; label: string }) {
  const animated = useAnimatedNumber(value);
  return (
    <div className="text-center">
      <div className="text-3xl font-semibold text-slate-100 tabular-nums">
        {animated.toLocaleString()}
      </div>
      <div className="mt-1 text-xs uppercase tracking-widest text-slate-500">{label}</div>
    </div>
  );
}

// dec-4 (ac-8/ac-12): the page is UNLISTED — noindex while mounted. The SPA has
// one shared index.html, so the directive is injected per-route and removed on
// unmount (every other route stays indexable).
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);
}

export function LivePage() {
  useNoIndex();
  const params = new URLSearchParams(window.location.search);
  const demo = params.get('demo') === '1';
  const { stats } = useLiveStats(demo);

  // The floor is server-enforced config (dec-1, LIVE_HEADCOUNT_FLOOR); the
  // ?floor= override is a dev/tuning affordance only.
  const floorOverride = Number(params.get('floor'));
  const floor = Number.isFinite(floorOverride) && floorOverride >= 0
    ? floorOverride
    : (stats?.config.headcountFloor ?? 25);
  const windowHours = stats?.config.mapWindowHours ?? 24;
  const headline = stats ? selectHeadline(stats, floor) : null;
  const humansNow = useAnimatedNumber(stats?.now.humans ?? 0);
  const agentsNow = useAnimatedNumber(stats?.now.agents ?? 0);
  const aboveFloor = headline?.tier === 'now';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans">
      <div className="mx-auto max-w-5xl px-6 py-14">
        {/* Header */}
        <div className="flex items-center justify-between">
          <a href="/" className="text-lg font-semibold tracking-tight text-slate-100">
            memex<span className="text-violet-400">.ai</span>
          </a>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            LIVE
            {demo && (
              <span className="ml-2 rounded-md bg-amber-500/15 px-2 py-0.5 font-medium text-amber-400">
                DEMO DATA
              </span>
            )}
          </div>
        </div>

        {/* Headline — floor-gated (dec-5/dec-1) */}
        <div className="mt-14 text-center">
          {/* dec-5/dec-1 honesty cascade via selectHeadline: live headcount above
              the floor; else last-hour motion; else weekly motion. Never a small
              or zero number. */}
          {headline?.tier === 'now' ? (
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-slate-50">
              <span className="text-sky-400 tabular-nums">{humansNow.toLocaleString()}</span> humans
              and{' '}
              <span className="text-violet-400 tabular-nums">{agentsNow.toLocaleString()}</span>{' '}
              agents are building in Memex right now
            </h1>
          ) : headline?.tier === 'hour' ? (
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-slate-50">
              Memex is alive with work —{' '}
              <span className="text-violet-400 tabular-nums">
                {headline.events.toLocaleString()}
              </span>{' '}
              things happened in the last hour
            </h1>
          ) : (
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-slate-50">
              <span className="text-sky-400 tabular-nums">
                {(headline?.tier === 'week' ? headline.specs : 0).toLocaleString()}
              </span>{' '}
              specs and{' '}
              <span className="text-violet-400 tabular-nums">
                {(headline?.tier === 'week' ? headline.decisions : 0).toLocaleString()}
              </span>{' '}
              decisions shipped in Memex this week
            </h1>
          )}
          <p className="mt-4 text-sm text-slate-500">
            Humans and their coding agents, shipping software through living specs.
            {aboveFloor ? '' : ' Live activity from the last hour, updating as it happens.'}
          </p>
        </div>

        {/* Map */}
        <div className="mt-12 rounded-2xl border border-slate-800/80 bg-slate-900/40 p-6">
          <WorldMap points={stats?.points ?? []} />
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-sky-400" /> humans
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-violet-400" /> agents
              </span>
            </div>
            <span>
              activity in the last {windowHours === 1 ? 'hour' : `${windowHours} hours`} · locations
              approximate
              {stats?.geoSource === 'demo' ? ' · demo geo' : ''}
            </span>
          </div>
        </div>

        {/* Rolling totals (dec-3 candidates) */}
        <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat value={stats?.totals.specsCreatedThisWeek ?? 0} label="specs this week" />
          <Stat
            value={stats?.totals.decisionsResolvedThisWeek ?? 0}
            label="decisions resolved this week"
          />
          <Stat value={stats?.totals.toolCallsToday ?? 0} label="agent calls today" />
          <Stat value={stats?.totals.eventsToday ?? 0} label="changes today" />
        </div>

        {/* Ticker */}
        <div className="mt-12">
          <div className="text-xs uppercase tracking-widest text-slate-500">Happening now</div>
          <ul className="mt-4 space-y-2">
            {(stats?.ticker ?? []).slice(0, 10).map((t, i) => (
              <li
                key={`${t.at}-${i}`}
                className="flex items-center justify-between rounded-lg border border-slate-800/60 bg-slate-900/30 px-4 py-2.5 text-sm"
                style={{ opacity: Math.max(0.45, 1 - i * 0.07) }}
              >
                <span className="flex items-center gap-3">
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      t.actorKind === 'agent' ? 'bg-violet-400' : 'bg-sky-400'
                    }`}
                  />
                  <span className="text-slate-300">{t.text}</span>
                </span>
                <span className="text-xs text-slate-600">{timeAgo(t.at)}</span>
              </li>
            ))}
            {stats && stats.ticker.length === 0 && (
              <li className="text-sm text-slate-600">Quiet right now — check back shortly.</li>
            )}
          </ul>
        </div>

        {/* Footer */}
        <div className="mt-16 flex items-center justify-between border-t border-slate-800/60 pt-6 text-xs text-slate-600">
          <span>
            Anonymous by construction — no names, titles, or content; locations are approximate.
          </span>
          <a href="/" className="text-slate-400 hover:text-slate-200">
            Start building →
          </a>
        </div>
      </div>
    </div>
  );
}

export default LivePage;
