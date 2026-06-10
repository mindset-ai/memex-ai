// spec-222 t-5 (dec-1 / ac-7 / ac-8) — the bundle's HEAVY ENGINE chunk.
//
// This module is loaded LAZILY by the loader's dynamic `import('./engine')` on the
// FIRST Specky-doorway click — Vite code-splits it into its own hashed chunk, so a
// visitor who never invokes the guide never downloads React or the orchestrator
// (ac-8). It pulls in the full session stack (React + VoiceSessionProvider +
// VoiceSessionPill + Specky + the recovery card + the live mic→STT→graph→TTS
// orchestrator), mounts it into the SAME shadow root the loader created (so all
// guide UI stays isolated — ac-7), and wires the injected navigation adapter,
// backend, surface, and capabilities from init()'s config.
//
// It REUSES the engine's existing exports (createVoiceOrchestratorFactory, the
// session provider/pill, Specky) — no duplicated engine logic (dec-5).

import { StrictMode, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { setGuideBackend } from '../backend';
import { createVoiceOrchestratorFactory } from '../orchestrator/voiceGuideOrchestrator';
import {
  VoiceSessionProvider,
  useVoiceSession,
} from '../session/VoiceSessionContext';
import { VoiceSessionPill } from '../session/VoiceSessionPill';
import { VoiceIcon } from '../session/VoiceIcon';
import { Specky } from '../components/Specky';
import type { GuideBundleConfig, MountedEngine } from './types';

/**
 * Mint a short-lived anonymous guide session token from the public endpoint
 * (POST `${backend}/session`). The browser's fetch carries the Origin header the
 * endpoint gates on; the returned token binds the surface and is what the WS +
 * SSE legs authenticate against (t-10). Returns null on any failure — the
 * orchestrator then surfaces a clean "not authenticated" error.
 */
async function mintAnonGuideToken(config: GuideBundleConfig): Promise<string | null> {
  try {
    const res = await fetch(`${config.backend}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surface: config.surface }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === 'string' ? body.token : null;
  } catch {
    return null;
  }
}

/**
 * Mount the full voice engine into the loader's shadow root and hand back an
 * unmount handle. Called exactly once, on the first doorway click. Async because
 * it MINTS the anonymous session token before starting (the WS/SSE legs need it).
 */
export async function mountEngine({
  shadow,
  config,
}: {
  shadow: ShadowRoot;
  config: GuideBundleConfig;
}): Promise<MountedEngine> {
  // The injected backend: the public endpoint's leg paths differ from the app's
  // (the app authenticates the SSE leg with an Authorization header; the public
  // endpoint reads `?token=` on BOTH legs — t-10).
  setGuideBackend({
    baseUrl: config.backend,
    chatPath: '/chat',
    voicePath: '/voice',
    tokenInQuery: true,
  });

  // Mint the anon token BEFORE the session starts (AutoStart calls start() on
  // mount, which reads authToken() synchronously to open the WS).
  const token = await mintAnonGuideToken(config);

  const adapter = config.navigation;

  // Build the live orchestrator factory ONCE, bound to the injected adapter. The
  // website omits the walkthrough capability (config.capabilities ?? {}) so the
  // demo tools stay inert (ac-6, ac-18). The demo hooks are no-ops here — the
  // public site has no demo board / walkthrough sequencer to drive.
  const factory = createVoiceOrchestratorFactory({
    adapter,
    capabilities: config.capabilities ?? {},
    advanceDemo: () => {},
    startWalkthrough: () => {},
    // The anon token authenticates both the WS (?token=) and the SSE leg.
    authToken: () => token,
    // The WS base is the public endpoint base; voicePath ('/voice') is set above.
    tenantBase: () => config.backend,
    origin: typeof window !== 'undefined' ? window.location.origin : '',
    getScreenContext: () => {
      const screenKey = adapter.currentScreenKey();
      return {
        screenKey,
        screenRegistry: adapter.elementsForScreen?.(screenKey) ?? [],
        // The static site is not tenant-scoped; surface identifies the host.
        namespace: config.surface,
        memex: '',
      };
    },
  });

  // A dedicated mount container inside the shadow root keeps the React tree's DOM
  // isolated from the loader's doorway node (ac-7).
  const container = document.createElement('div');
  container.setAttribute('data-memex-guide', 'engine');
  shadow.appendChild(container);

  const root: Root = createRoot(container);
  root.render(
    <StrictMode>
      <VoiceSessionProvider orchestratorFactory={factory}>
        {/* The doorway click that loaded this chunk WAS the user's intent to talk,
            so auto-start the session once on mount (the engine's icon doorway then
            re-appears if the user ends the session). */}
        <AutoStart />
        <GuideOverlay />
      </VoiceSessionProvider>
    </StrictMode>,
  );

  return {
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

/** Auto-start the session exactly once on first mount (the doorway click handed
 *  off to the engine to begin talking). Renders nothing. */
function AutoStart(): null {
  const session = useVoiceSession();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void session.start();
    // Run once; `session.start` identity is stable for the provider's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

const ANCHOR_STYLE: React.CSSProperties = {
  position: 'fixed',
  bottom: 24,
  right: 24,
  zIndex: 2147483000,
};

/**
 * The bundle's session overlay — the website's standalone equivalent of the app's
 * VoiceLayer (which stays app-side because it reads react-router + the registry).
 * Here the screen is resolved through the injected adapter, so this needs neither.
 *   - active session            → the floating pill (persists across turns);
 *   - permission denied / error → the recovery card with retry;
 *   - otherwise                 → the in-view Specky icon (the doorway handed off,
 *                                 so the user can re-open after ending a session).
 */
function GuideOverlay(): React.JSX.Element | null {
  const session = useVoiceSession();

  if (session.status === 'active') {
    return (
      <div style={ANCHOR_STYLE}>
        <VoiceSessionPill />
      </div>
    );
  }

  if (session.status === 'permission_denied' || session.status === 'error') {
    return (
      <div style={ANCHOR_STYLE}>
        <VoiceRecovery />
      </div>
    );
  }

  return (
    <div style={ANCHOR_STYLE}>
      <VoiceIcon mark={<Specky size={40} />} />
    </div>
  );
}

/** Denied-permission / error recovery (mirrors the app's VoiceLayer recovery). */
function VoiceRecovery(): React.JSX.Element {
  const session = useVoiceSession();
  const denied = session.status === 'permission_denied';
  return (
    <div
      data-voice-recovery
      data-recovery-kind={denied ? 'permission_denied' : 'error'}
      className="max-w-xs rounded-lg bg-surface p-3 text-sm shadow-lg ring-1 ring-border"
    >
      <p className="text-text-primary">
        {denied
          ? 'Microphone access is blocked. Enable it for this site in your browser, then retry.'
          : `The voice guide hit an error${session.error ? `: ${session.error}` : ''}.`}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          data-voice-retry
          onClick={() => void session.retryPermission()}
          className="rounded-md bg-accent px-2 py-1 text-white"
        >
          Retry
        </button>
        <button
          type="button"
          data-voice-dismiss
          onClick={session.end}
          className="rounded-md px-2 py-1 text-text-secondary hover:bg-surface-hover"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
