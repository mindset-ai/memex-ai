// spec-190 t-8 (dec-5 / ac-29 / ac-31) — the voice session provider: owns the
// lifecycle, the mic-permission flow, and the granted stream, and exposes the
// state + actions the icon/pill render against. The orchestrator (t-3 remaining)
// plugs in via `orchestratorFactory` and drives the live loop state through hooks.
//
// Permission posture (ac-31): the mic is requested ONLY on session start (never on
// mount / page load). Denial → a recovery state; no usable mic → a disabled
// affordance. v1 keeps NO transcript — conversation lives only in the client graph
// for the session's lifetime; this provider stores none.

import {
  createContext,
  useContext,
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { micConstraints } from '../micVad';
import {
  initialVoiceSessionState,
  type VoiceSessionState,
} from './voiceSessionModel';
import {
  WebAudioEarconPlayer,
  type EarconPlayer,
} from './earcons';
import {
  stubOrchestratorFactory,
  type OrchestratorFactory,
  type OrchestratorHooks,
  type VoiceOrchestrator,
} from './orchestrator';

export interface VoiceSessionValue extends VoiceSessionState {
  /** Start a session: requests mic permission (first time), then begins the loop. */
  start: () => Promise<void>;
  /** Tap-to-interrupt the agent mid-speech (manual barge-in fallback). */
  interrupt: () => void;
  /** End the session and release the mic. */
  end: () => void;
  /** Retry from the permission-denied recovery UI. */
  retryPermission: () => Promise<void>;
}

const VoiceSessionContext = createContext<VoiceSessionValue | null>(null);

export function useVoiceSession(): VoiceSessionValue {
  const ctx = useContext(VoiceSessionContext);
  if (!ctx) throw new Error('useVoiceSession must be used within a VoiceSessionProvider');
  return ctx;
}

export interface VoiceSessionProviderProps {
  children: ReactNode;
  /** The real mic→STT→graph→TTS loop (t-3). Defaults to a no-op stub. */
  orchestratorFactory?: OrchestratorFactory;
  /** Earcon player. Defaults to WebAudio; tests inject a recorder. */
  earcons?: EarconPlayer;
  /** Injectable for tests; defaults to navigator.mediaDevices.getUserMedia. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Injectable mic-availability probe (no permission prompt). */
  detectMic?: () => boolean;
}

function defaultDetectMic(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export function VoiceSessionProvider({
  children,
  orchestratorFactory = stubOrchestratorFactory,
  earcons,
  getUserMedia,
  detectMic = defaultDetectMic,
}: VoiceSessionProviderProps): React.JSX.Element {
  const [state, setState] = useState<VoiceSessionState>(() =>
    initialVoiceSessionState(detectMic()),
  );
  // Mirror to a ref so the async start() reads current values without stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;

  const streamRef = useRef<MediaStream | null>(null);

  // Earcon player + orchestrator are created once. The orchestrator's hooks drive
  // the live loop state (only while active, so a late callback can't resurrect an
  // ended session).
  const earconPlayer = useMemo<EarconPlayer>(
    () => earcons ?? new WebAudioEarconPlayer(),
    [earcons],
  );

  const acquireMic = useMemo(
    () => getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)),
    [getUserMedia],
  );

  const orchestrator = useMemo<VoiceOrchestrator>(() => {
    const hooks: OrchestratorHooks = {
      setLoopState: (loopState) =>
        setState((s) => (s.status === 'active' ? { ...s, loopState } : s)),
      playEarcon: (e) => earconPlayer.play(e),
      onError: (message) =>
        setState((s) => ({ ...s, status: 'error', error: message })),
      onEnded: () =>
        setState((s) =>
          s.status === 'active'
            ? { ...s, status: 'inactive', loopState: 'idle' }
            : s,
        ),
    };
    return orchestratorFactory(hooks);
  }, [orchestratorFactory, earconPlayer]);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    const current = stateRef.current;
    if (current.status === 'active' || current.status === 'requesting_permission') {
      return; // idempotent — already starting / running
    }
    if (!current.micAvailable) {
      setState((s) => ({ ...s, status: 'mic_unavailable' }));
      return;
    }
    setState((s) => ({ ...s, status: 'requesting_permission', error: null }));

    let stream: MediaStream;
    try {
      // ac-31: permission is requested HERE (on start), never on page load.
      stream = await acquireMic(micConstraints());
    } catch {
      setState((s) => ({ ...s, status: 'permission_denied' }));
      return;
    }

    streamRef.current = stream;
    earconPlayer.play('start');
    setState((s) => ({ ...s, status: 'active', loopState: 'listening' }));

    try {
      await orchestrator.start(stream); // consumes the granted, AEC'd stream
    } catch (err) {
      releaseStream();
      setState((s) => ({ ...s, status: 'error', error: err instanceof Error ? err.message : String(err) }));
    }
  }, [acquireMic, earconPlayer, orchestrator, releaseStream]);

  const interrupt = useCallback(() => {
    if (stateRef.current.status !== 'active') return;
    orchestrator.interrupt();
    setState((s) => (s.status === 'active' ? { ...s, loopState: 'listening' } : s));
  }, [orchestrator]);

  const end = useCallback(() => {
    orchestrator.stop();
    releaseStream();
    earconPlayer.play('end');
    setState((s) => ({ ...s, status: 'inactive', loopState: 'idle', error: null }));
  }, [orchestrator, releaseStream, earconPlayer]);

  // Tear down on unmount — never leave the mic hot.
  useEffect(() => {
    return () => {
      orchestrator.stop();
      releaseStream();
      earconPlayer.dispose();
    };
  }, [orchestrator, releaseStream, earconPlayer]);

  const value = useMemo<VoiceSessionValue>(
    () => ({ ...state, start, interrupt, end, retryPermission: start }),
    [state, start, interrupt, end],
  );

  return <VoiceSessionContext.Provider value={value}>{children}</VoiceSessionContext.Provider>;
}
