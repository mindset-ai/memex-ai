// HotSpecs — spec-255: the HERO band. The specs being worked on RIGHT NOW,
// grouped by spec and ranked by heat (presence-first, then decayed activity
// tempo). Each card shows phase, who's on it (presence avatars), its live AC
// progress (reusing SpecHealthStrip), and the present-tense narrative line.
// Clicking a card goes to that spec; a phase change pops the phase chip.
//
// PRESENTATIONAL — rows + resolvers arrive via props.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { rankHotSpecs, quietLabel, type HotSpec } from './pulseDerive';
import { useChartPalette, phaseLabel, type Phase } from '../insights/theme';
import { SpecHealthStrip } from '../SpecHealthIndicator';
import type { ActivityRow, ActorKind, PresentRow } from './types';
import type { AcHealth } from '../../api/types';

export interface HotSpecsProps {
  /** Everyone present right now (presence plane), already merged. */
  present: PresentRow[];
  /** Persisted activity rows (history), for tempo + last-activity. */
  activity: ActivityRow[];
  /** Clock override for tests; defaults to Date.now(). */
  now?: number;
  /** docId → `spec-N` handle. */
  specHandle: (docId: string) => string | undefined;
  /** docId → human title. */
  specTitle?: (docId: string) => string | undefined;
  /** docId → lifecycle phase (draft|specify|build|verify|done). */
  specPhase?: (docId: string) => string | undefined;
  /** docId → present-tense narrative of the latest event. */
  specNarrative?: (docId: string) => string | undefined;
  /** docId → AC health roll-up (for the live AC progress bar). */
  specAcHealth?: (docId: string) => AcHealth | undefined;
  /** handle → route path for the card link. */
  specHref: (handle: string) => string;
}

function actorColor(kind: ActorKind, palette: ReturnType<typeof useChartPalette>): string {
  if (kind === 'system') return 'rgba(148,163,184,0.7)';
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
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-secondary border-b border-edge-subtle">
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
        <div className="flex gap-3 overflow-x-auto px-3 py-3">
          {ranked.map((spec) => (
            <HotSpecCard
              key={spec.docId}
              spec={spec}
              present={present}
              handle={specHandle(spec.docId)}
              title={specTitle?.(spec.docId)}
              phase={specPhase?.(spec.docId)}
              narrative={specNarrative?.(spec.docId)}
              health={specAcHealth?.(spec.docId)}
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
  present: PresentRow[];
  handle: string | undefined;
  title: string | undefined;
  phase: string | undefined;
  narrative: string | undefined;
  health: AcHealth | undefined;
  specHref: (handle: string) => string;
}

function HotSpecCard({
  spec,
  present,
  handle,
  title,
  phase,
  narrative,
  health,
  specHref,
}: HotSpecCardProps) {
  const palette = useChartPalette();
  const href = handle ? specHref(handle) : '#';
  const workers = present.filter((p) => p.docId === spec.docId);

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

  return (
    <Link
      to={href}
      data-testid="hot-spec-card"
      data-doc-id={spec.docId}
      data-state={spec.state}
      className="relative block min-w-[200px] max-w-[240px] flex-none rounded-md border border-edge-subtle bg-surface/60 px-3 pt-2 pb-3 hover:border-edge transition-colors"
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

      {/* State / quiet label (honest floor: "quiet Nm", never "waiting"). */}
      <div data-testid="hot-spec-state" className="mt-1 text-[0.7rem]">
        {spec.state === 'quiet' && spec.ageMs != null ? (
          <span className="text-status-warning-text">{quietLabel(spec.ageMs)}</span>
        ) : spec.state === 'cooling' ? (
          <span className="text-muted">cooling</span>
        ) : (
          <span className="text-status-success-text">active</span>
        )}
      </div>

      {/* Who's on it — presence avatars (human + agent), coloured by kind. */}
      {workers.length > 0 ? (
        <div className="mt-1.5 flex items-center" data-testid="hot-spec-avatars">
          {workers.slice(0, 4).map((w, i) => (
            <span
              key={`${w.actorUserId}-${w.clientId}-${i}`}
              className="h-4 w-4 rounded-full border border-surface -ml-1 first:ml-0"
              style={{ background: actorColor(w.actorKind, palette) }}
              title={w.actorName ?? w.actorKind}
            />
          ))}
        </div>
      ) : null}

      {/* Present-tense line (activity_log narrative). */}
      {narrative ? (
        <div data-testid="hot-spec-line" className="mt-1.5 text-[0.7rem] italic text-secondary line-clamp-1">
          &ldquo;{narrative}&rdquo;
        </div>
      ) : null}

      {/* Live AC progress — reuse the board's health strip (green/rose/amber). */}
      <SpecHealthStrip health={health} />
    </Link>
  );
}
