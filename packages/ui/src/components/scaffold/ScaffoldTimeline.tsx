// spec-343 t-1: the lifecycle-timeline spine.
//
// dec-1 — the surface is organised around the Spec lifecycle
// draft → specify → build → verify → done, with the four forward gates drawn as
// the connectors between adjacent phases. Visually this reuses the app's
// canonical phase language (phaseColors + the PhaseTabBar pill idiom): rounded
// pills for phases (filled in the phase's hue when selected, ghost when
// resting) joined by interactive `→gate` connectors. Badges mark where the team
// has added Org guidance (dec-7 / ac-13).

import { Fragment } from 'react';
import type { GuidanceBlock, Phase, Transition } from '@memex/shared';
import { phaseColors } from '../phaseColors';
import { orgCountForPhase, orgCountForTransition } from './composition';

const PHASES: Phase[] = ['draft', 'specify', 'build', 'verify', 'done'];

/** The forward transition that departs each phase (null for the terminal one). */
const GATE_AFTER: Record<Phase, Transition | null> = {
  draft: 'specify',
  specify: 'build',
  build: 'verify',
  verify: 'done',
  done: null,
};

export type TimelineSelection =
  | { kind: 'phase'; phase: Phase }
  | { kind: 'gate'; transition: Transition };

interface Props {
  selected: TimelineSelection | null;
  orgBlocks: readonly GuidanceBlock[];
  onSelectPhase: (phase: Phase) => void;
  onSelectGate: (transition: Transition) => void;
  /** spec-360: when true, the ACTIVE control's ring brightens — the assistant
   *  just navigated here and the user's eye should follow. */
  pulse?: boolean;
}

// spec-360: the ACTIVE control always wears a clear ring so the selection is
// visible; it brightens briefly when the assistant has just navigated here.
// (matches ScaffoldInspect's SELECT_RING / PULSE_RING.)
const SELECT_RING = 'ring-2 ring-accent/60 ring-offset-1 ring-offset-surface';
const PULSE_RING = 'ring-2 ring-accent ring-offset-1 ring-offset-surface';
function ring(active: boolean, pulse: boolean): string {
  if (!active) return '';
  return pulse ? PULSE_RING : SELECT_RING;
}

function CountDot({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="scaffold-org-badge"
      title={`${count} guidance addition${count === 1 ? '' : 's'} from ${label}`}
      className="ml-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-500"
    >
      {count}
    </span>
  );
}

const PILL_BASE =
  'relative inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wider transition-colors';

export function ScaffoldTimeline({ selected, orgBlocks, onSelectPhase, onSelectGate, pulse = false }: Props) {
  return (
    <nav
      data-testid="scaffold-timeline"
      aria-label="Spec lifecycle"
      className="flex items-center gap-1.5 flex-wrap"
    >
      {PHASES.map((phase) => {
        const gate = GATE_AFTER[phase];
        const phaseActive = selected?.kind === 'phase' && selected.phase === phase;
        const gateActive = gate !== null && selected?.kind === 'gate' && selected.transition === gate;
        return (
          <Fragment key={phase}>
            <button
              type="button"
              data-testid={`scaffold-timeline-phase-${phase}`}
              aria-current={phaseActive ? 'true' : undefined}
              onClick={() => onSelectPhase(phase)}
              className={`${PILL_BASE} ${
                phaseActive
                  ? (phaseColors(phase)?.pill ?? 'border-edge bg-overlay text-primary')
                  : 'border-transparent text-secondary hover:text-primary hover:bg-overlay'
              } ${ring(phaseActive, pulse)}`}
            >
              <span>{phase}</span>
              <CountDot count={orgCountForPhase(orgBlocks, phase)} label="your org" />
            </button>
            {gate ? (
              <button
                type="button"
                data-testid={`scaffold-timeline-gate-${gate}`}
                aria-current={gateActive ? 'true' : undefined}
                onClick={() => onSelectGate(gate)}
                title={`Gate: ${phase} → ${gate}`}
                className={`group inline-flex items-center gap-0.5 rounded-sm px-1 text-[11px] tracking-wide transition-colors ${
                  gateActive ? 'text-primary font-semibold' : 'text-muted hover:text-primary'
                } ${ring(gateActive, pulse)}`}
              >
                <span aria-hidden="true" className="text-sm leading-none">
                  →
                </span>
                <span className="uppercase">{gate}</span>
                <CountDot count={orgCountForTransition(orgBlocks, gate)} label="your org" />
              </button>
            ) : null}
          </Fragment>
        );
      })}
    </nav>
  );
}
