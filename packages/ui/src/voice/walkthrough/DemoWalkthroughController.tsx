// spec-211 t-3: mounts the demo walkthrough sequencer into the voice layer and
// registers its `start` so the guide's `start_walkthrough` tool (emitted when the
// user accepts — t-4) can hand control to the client. Renders nothing.

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVoiceSession } from '@memex/guide-sdk';
import { useHandholdRevealValue } from '../../hooks/HandholdRevealContext';
import { REVEAL_PHASES, type RevealPhase } from '../../hooks/useHandholdReveal';
import { fetchDocs } from '../../api/client';
import { tenantPath } from '../../utils/tenantUrl';
import type { DocSummary } from '../../api/types';
import { runDemoTour } from './demoWalkthrough';
import { demoSpecPathForPhase } from './demoSpecs';

const DEFAULT_BOARD_PAUSE_MS = 900;

const defaultFetchDemoDocs = async (): Promise<DocSummary[]> =>
  (await fetchDocs('spec')).filter((d) => d.isDemo === true);

const defaultPause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface DemoWalkthroughControllerProps {
  namespace: string | null;
  memex: string | null;
  /** A ref the parent threads into the orchestrator's `startWalkthrough` dep; the
   *  controller writes its `start` fn here so the guide tool can trigger the tour. */
  startRef: MutableRefObject<() => void>;
  /** Injectable for tests. */
  fetchDemoDocs?: () => Promise<DocSummary[]>;
  pause?: (ms: number) => Promise<void>;
  boardPauseMs?: number;
}

export function DemoWalkthroughController({
  namespace,
  memex,
  startRef,
  fetchDemoDocs = defaultFetchDemoDocs,
  pause = defaultPause,
  boardPauseMs = DEFAULT_BOARD_PAUSE_MS,
}: DemoWalkthroughControllerProps): null {
  const session = useVoiceSession();
  const { reset: resetReveal, advance: advanceReveal } = useHandholdRevealValue(namespace, memex);
  const navigate = useNavigate();

  // Live status for the loop's isActive() guard (avoids a stale closure).
  const statusRef = useRef(session.status);
  statusRef.current = session.status;
  // narratePhase identity changes per render; read it fresh from a ref too.
  const narrateRef = useRef(session.narratePhase);
  narrateRef.current = session.narratePhase;

  const runningRef = useRef(false);
  const boardPath = tenantPath('/specs');

  const start = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    void (async () => {
      try {
        const docs = await fetchDemoDocs();
        await runDemoTour({
          phases: REVEAL_PHASES,
          isActive: () => statusRef.current === 'active',
          resetReveal,
          advanceReveal,
          openPath: (phase: RevealPhase) => demoSpecPathForPhase(docs, phase),
          navigate,
          boardPath,
          narratePhase: (phase: RevealPhase) =>
            narrateRef.current(
              `Narrate the ${phase} phase of the demo walkthrough now, in a sentence or two, then give a short cue toward the next step.`,
            ),
          pause,
          boardPauseMs,
        });
      } finally {
        runningRef.current = false;
      }
    })();
  }, [fetchDemoDocs, resetReveal, advanceReveal, navigate, boardPath, pause, boardPauseMs]);

  // Register the start fn so the orchestrator's startWalkthrough dep can call it.
  useEffect(() => {
    startRef.current = start;
  }, [start, startRef]);

  return null;
}
