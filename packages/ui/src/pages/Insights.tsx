// Insights — per-memex spec analytics (spec-179, dec-2).
//
// A single scrollable page (no sub-tabs in v1): the specs-over-time hero
// full-width, then by-phase + phase-durations cards. All three datasets come
// from the read-only /analytics/* aggregates; this page owns fetching and the
// loading/empty/error states, the chart components own presentation.
//
// Young memexes see an explicit empty state ("charts unlock as specs
// accumulate") instead of empty axes (Design, spec-179 s-7).

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  fetchSpecsOverTime,
  fetchSpecsByPhase,
  fetchPhaseDurations,
  fetchPipelineFunnel,
  fetchActivityByActor,
  fetchAcVerification,
  type SpecsOverTimePoint,
  type SpecsByPhasePoint,
  type PhaseDurations,
  type FunnelStage,
  type ActivityByActorPoint,
  type AcVerificationSummary,
} from '../api/client';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/ui';
import { SpecsOverTimeChart } from '../components/insights/SpecsOverTimeChart';
import { SpecsByPhaseChart } from '../components/insights/SpecsByPhaseChart';
import { PhaseDurationsChart } from '../components/insights/PhaseDurationsChart';
import { PipelineFunnelChart } from '../components/insights/PipelineFunnelChart';
import { ActivityStreamChart } from '../components/insights/ActivityStreamChart';
import { AcVerificationChart } from '../components/insights/AcVerificationChart';

// Below this many specs the charts are noise — show the unlock note instead.
const MIN_SPECS_FOR_CHARTS = 3;

interface InsightsData {
  overTime: SpecsOverTimePoint[];
  byPhase: SpecsByPhasePoint[];
  durations: PhaseDurations;
  funnel: FunnelStage[];
  activity: ActivityByActorPoint[];
  verification: AcVerificationSummary;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: InsightsData };

export function Insights() {
  // Re-fetch when the tenant in the URL changes (ac-15: switching memex
  // switches the data — tBase() reads the path, the params are the trigger).
  const { namespace, memex } = useParams<{ namespace: string; memex: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    Promise.all([
      fetchSpecsOverTime(),
      fetchSpecsByPhase(),
      fetchPhaseDurations(),
      fetchPipelineFunnel(),
      fetchActivityByActor(),
      fetchAcVerification(),
    ])
      .then(([overTime, byPhase, durations, funnel, activity, verification]) => {
        if (cancelled) return;
        setState({
          kind: 'ready',
          data: { overTime, byPhase, durations, funnel, activity, verification },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to load' });
      });
    return () => {
      cancelled = true;
    };
  }, [namespace, memex]);

  const total =
    state.kind === 'ready' && state.data.overTime.length > 0
      ? state.data.overTime[state.data.overTime.length - 1].cumulative
      : 0;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6" data-testid="insights-page">
      <PageHeader title="Insights" />

      {state.kind === 'loading' && (
        <div className="text-sm text-secondary py-12 text-center" data-testid="insights-loading">
          Loading analytics…
        </div>
      )}

      {state.kind === 'error' && (
        <div className="text-sm text-secondary py-12 text-center" data-testid="insights-error">
          Couldn&apos;t load analytics: {state.message}
        </div>
      )}

      {state.kind === 'ready' && total < MIN_SPECS_FOR_CHARTS && (
        <Card data-testid="insights-empty">
          <div className="py-10 text-center">
            <div className="text-base font-medium mb-1">Charts unlock as specs accumulate</div>
            <div className="text-sm text-secondary">
              {total === 0
                ? 'This memex has no specs yet.'
                : `${total} spec${total === 1 ? '' : 's'} so far — come back once there are a few more.`}
            </div>
          </div>
        </Card>
      )}

      {state.kind === 'ready' && total >= MIN_SPECS_FOR_CHARTS && (
        <div className="flex flex-col gap-4">
          <Card>
            <div className="flex items-baseline justify-between mb-2">
              <h2 className="text-sm font-semibold">Specs over time</h2>
              <span className="text-xs text-secondary">{total} total</span>
            </div>
            <SpecsOverTimeChart points={state.data.overTime} />
          </Card>

          <Card>
            <h2 className="text-sm font-semibold">Specs by phase</h2>
            {/* The honesty caveat — required until status_changed history
                (ac-5) accumulates enough to reconstruct true phase history. */}
            <div className="text-xs text-secondary mb-2">phases shown as of today</div>
            <SpecsByPhaseChart points={state.data.byPhase} />
          </Card>
          <Card>
            <h2 className="text-sm font-semibold mb-2">Phase durations</h2>
            <PhaseDurationsChart durations={state.data.durations} />
          </Card>
          <Card>
            <h2 className="text-sm font-semibold">Pipeline funnel</h2>
            <div className="text-xs text-secondary mb-2">
              active specs at or beyond each phase
            </div>
            <PipelineFunnelChart stages={state.data.funnel} />
          </Card>
          <Card>
            <h2 className="text-sm font-semibold">AC verification</h2>
            <div className="text-xs text-secondary mb-2">
              latest test emissions across every active acceptance criterion
            </div>
            <AcVerificationChart summary={state.data.verification} />
          </Card>
          {state.data.activity.length > 0 && (
            <Card>
              <h2 className="text-sm font-semibold">Who's doing the work</h2>
              <div className="text-xs text-secondary mb-2">
                daily activity by actor — humans vs agents (reads and test-event noise excluded)
              </div>
              <ActivityStreamChart points={state.data.activity} />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
