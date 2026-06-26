// spec-406: the Stats tab body. One scrollable column of cards, in the dec-5
// order: lifecycle summary strip → phase-duration timeline → (task velocity + AC
// donut, half-width pair) → who/what/when activity audit. Owns fetching the four
// snapshot aggregates in parallel; the audit owns its own paging/toggle fetch.
// Every number is server-computed (SQL) — this view only formats and arranges.

import { useEffect, useState } from 'react';
import {
  fetchSpecPhaseDurations,
  fetchSpecSummary,
  fetchSpecTaskVelocity,
  fetchSpecAcVerification,
  type SpecPhaseDurations,
  type SpecLifecycleSummary,
  type SpecTaskVelocity,
} from '../../api/insights';
import type { AcVerificationSummary } from '../../api/client';
import { Card } from '../ui';
import { SpecSummaryStrip } from './SpecSummaryStrip';
import { SpecPhaseTimelineChart } from './SpecPhaseTimelineChart';
import { SpecTaskVelocityChart } from './SpecTaskVelocityChart';
import { AcVerificationChart } from './AcVerificationChart';
import { SpecActivityAudit } from './SpecActivityAudit';

interface Props {
  /** The spec handle (spec-N) or UUID — becomes the /analytics/spec/<ref>/… segment. */
  specRef: string;
}

interface StatsData {
  summary: SpecLifecycleSummary;
  durations: SpecPhaseDurations;
  velocity: SpecTaskVelocity;
  verification: AcVerificationSummary;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: StatsData };

export function StatsView({ specRef }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    Promise.all([
      fetchSpecSummary(specRef),
      fetchSpecPhaseDurations(specRef),
      fetchSpecTaskVelocity(specRef),
      fetchSpecAcVerification(specRef),
    ])
      .then(([summary, durations, velocity, verification]) => {
        if (cancelled) return;
        setState({ kind: 'ready', data: { summary, durations, velocity, verification } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load' });
      });
    return () => {
      cancelled = true;
    };
  }, [specRef]);

  if (state.kind === 'loading') {
    return (
      <div data-testid="spec-stats-loading" className="text-sm text-secondary py-12 text-center">
        Loading stats…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div data-testid="spec-stats-error" className="text-sm text-secondary py-12 text-center">
        Couldn&apos;t load stats: {state.message}
      </div>
    );
  }

  const { summary, durations, velocity, verification } = state.data;

  return (
    <div data-testid="spec-stats-view" className="flex flex-col gap-4">
      <Card>
        <SpecSummaryStrip summary={summary} />
      </Card>

      <Card>
        <h2 className="text-sm font-semibold mb-3">Phase timeline</h2>
        <SpecPhaseTimelineChart data={durations} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <h2 className="text-sm font-semibold mb-2">Task velocity</h2>
          <SpecTaskVelocityChart points={velocity.points} />
        </Card>
        <Card>
          <h2 className="text-sm font-semibold mb-2">AC verification</h2>
          <AcVerificationChart summary={verification} />
        </Card>
      </div>

      <Card>
        <h2 className="text-sm font-semibold mb-2">Activity</h2>
        <SpecActivityAudit specRef={specRef} />
      </Card>
    </div>
  );
}
