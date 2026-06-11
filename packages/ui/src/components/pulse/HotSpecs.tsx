// HotSpecs — spec-255: the HERO band. The specs being worked on RIGHT NOW,
// grouped by spec and ranked by heat (presence-first, then decayed activity
// tempo). Each card shows phase (with a phase-change pop), who's on it (presence
// avatars), its live AC cells, a per-spec line sparkline, and the present-tense
// narrative line. Clicking a card opens the spec.
//
// PRESENTATIONAL — rows + resolvers arrive via props.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { rankHotSpecs, coolingLabel, tempoSeries, involvedOnSpec, type HotSpec, type Worker } from './pulseDerive';
import { useChartPalette, phaseLabel, type Phase } from '../insights/theme';
import { AcCells } from './AcCells';
import { Sparkline } from './Sparkline';
import type { ActivityRow, ActorKind, PresentRow } from './types';
import type { AcHealth } from '../../api/types';

export interface HotSpecsProps {
  present: PresentRow[];
  activity: ActivityRow[];
  now?: number;
  specHandle: (docId: string) => string | undefined;
  specTitle?: (docId: string) => string | undefined;
  specPhase?: (docId: string) => string | undefined;
  specNarrative?: (docId: string) => string | undefined;
  specAcHealth?: (docId: string) => AcHealth | undefined;
  specHref: (handle: string) => string;
}

const QUIET_COLOR = '#d97706'; // amber-600
const COOLING_COLOR = 'rgba(148,163,184,0.7)';

function actorColor(kind: ActorKind, palette: ReturnType<typeof useChartPalette>): string {
  if (kind === 'system') return COOLING_COLOR;
  return palette.actor[kind];
}

export function HotSpecs({
  present,
  activity,
  now,
  specHandle,
  specTitle,
  specPhase,
  specNarrative,
  specAcHealth,
  specHref,
}: HotSpecsProps) {
  const clock = now ?? Date.now();
  const ranked = useMemo(
    () => rankHotSpecs(present, activity, { now: clock }),
    [present, activity, clock],
  );

  return (
    <section
      data-testid="hot-specs"
      className="flex-none rounded-lg border border-edge-subtle bg-surface/40 overflow-hidden mb-4"
    >
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs text-secondary border-b border-edge-subtle cursor-help"
        title="Hot specs — the specs being worked right now, ranked by heat (who's present plus how recent and frequent the meaningful events are). A spec stays ACTIVE for 5 minutes after its last event, then COOLING, and drops off ~10 minutes after going quiet."
      >
        <span className="font-medium text-primary">Hot specs</span>
        <span className="opacity-40">&middot;</span>
        <span>now</span>
        <span className="ml-auto text-[0.7rem] text-muted">ranked by heat</span>
      </div>
      {ranked.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted" data-testid="hot-specs-empty">
          No specs are being worked right now.
        </div>
      ) : (
        <div className="flex flex-wrap gap-3 px-3 py-3">
          {ranked.map((spec) => (
            <HotSpecCard
              key={spec.docId}
              spec={spec}
              involved={involvedOnSpec(present, activity, spec.docId, clock)}
              handle={specHandle(spec.docId)}
              title={specTitle?.(spec.docId)}
              phase={specPhase?.(spec.docId)}
              narrative={specNarrative?.(spec.docId)}
              health={specAcHealth?.(spec.docId)}
              spark={tempoSeries(activity, clock, 30, spec.docId)}
              specHref={specHref}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface HotSpecCardProps {
  spec: HotSpec;
  involved: Worker[];
  handle: string | undefined;
  title: string | undefined;
  phase: string | undefined;
  narrative: string | undefined;
  health: AcHealth | undefined;
  spark: number[];
  specHref: (handle: string) => string;
}

function HotSpecCard({
  spec,
  involved,
  handle,
  title,
  phase,
  narrative,
  health,
  spark,
  specHref,
}: HotSpecCardProps) {
  const palette = useChartPalette();
  const href = handle ? specHref(handle) : '#';
  const workers = involved;

  // Phase-pop (ac-18): when the phase changes, pop the chip once.
  const prevPhase = useRef<string | undefined>(phase);
  const [popping, setPopping] = useState(false);
  useEffect(() => {
    if (prevPhase.current !== undefined && phase !== undefined && prevPhase.current !== phase) {
      setPopping(true);
      const id = setTimeout(() => setPopping(false), 900);
      prevPhase.current = phase;
      return () => clearTimeout(id);
    }
    prevPhase.current = phase;
  }, [phase]);

  const sparkColor = spec.state === 'cooling' ? QUIET_COLOR : palette.accent;

  const tint =
    spec.state === 'cooling'
      ? 'border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 opacity-90'
      : 'border-edge-subtle bg-surface/60';

  return (
    <Link
      to={href}
      data-testid="hot-spec-card"
      data-doc-id={spec.docId}
      data-state={spec.state}
      className={`block w-[230px] flex-none rounded-lg border p-3 hover:border-edge transition-colors ${tint}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-accent">{handle ?? 'a spec'}</span>
        {phase ? (
          <span
            data-testid="phase-chip"
            data-popping={popping ? 'true' : undefined}
            className={`text-[10px] uppercase tracking-wide rounded px-1 border border-current ${
              popping ? 'animate-phase-pop' : ''
            }`}
            style={{ color: palette.phase[phase as Phase] ?? 'inherit' }}
          >
            {phaseLabel(phase)}
          </span>
        ) : null}
      </div>

      {title ? (
        <div className="mt-1 text-xs text-secondary line-clamp-2 min-h-[2rem]">{title}</div>
      ) : null}

      {/* State (left) + per-spec line sparkline (right). */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span data-testid="hot-spec-state" className="inline-flex items-center gap-1.5 text-[0.7rem]">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: spec.state === 'cooling' ? QUIET_COLOR : palette.testRun.pass }}
          />
          {spec.state === 'cooling' && spec.ageMs != null ? (
            <span className="text-status-warning-text">{coolingLabel(spec.ageMs)}</span>
          ) : (
            <span className="text-status-success-text">active</span>
          )}
        </span>
        <Sparkline values={spark} color={sparkColor} width={64} height={20} live={spec.state === 'hot'} />
      </div>

      {/* Live AC cells — one per AC (green / red / amber / grey). */}
      <div className="mt-2">
        <AcCells health={health} />
      </div>

      {/* Who's on it (avatars) + present-tense work line. */}
      <div className="mt-2 flex items-center justify-between gap-2 min-h-[1rem]">
        {workers.length > 0 ? (
          <div className="flex items-center" data-testid="hot-spec-avatars">
            {workers.slice(0, 4).map((w, i) => (
              <span
                key={`${w.actorUserId}-${w.clientId}-${i}`}
                className="flex h-4 w-4 items-center justify-center rounded-full border border-surface -ml-1 first:ml-0 text-[8px] font-semibold text-white"
                style={{ background: actorColor(w.actorKind, palette) }}
                title={w.actorName ?? w.actorKind}
              >
                {w.actorKind === 'human' ? (w.actorName?.[0]?.toUpperCase() ?? 'U') : ''}
              </span>
            ))}
          </div>
        ) : (
          <span />
        )}
        {narrative ? (
          <span
            data-testid="hot-spec-line"
            className="text-[0.7rem] italic text-secondary line-clamp-1 text-right"
          >
            &ldquo;{narrative}&rdquo;
          </span>
        ) : null}
      </div>
    </Link>
  );
}
