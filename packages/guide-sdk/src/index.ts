// @memex/guide-sdk — the reusable voice-guide engine, carved out of the Memex app
// (spec-222 dec-5). ONE source consumed by both `packages/ui` (the Memex app) and
// the SDK bundle that ships to the static marketing site. The engine imports
// NEITHER react-router NOR `@memex/shared` (ac-9) — the navigation coupling is
// satisfied only through the injected NavigationAdapter (dec-2).

// --- the navigation seam (dec-2) ---
export type {
  NavigationAdapter,
  NavigateOutcome,
  GuideElement,
  GuideLocation,
} from './navigation/NavigationAdapter';

// --- the built-in static-site adapter the website passes to init() (dec-2, t-3) ---
export { staticSiteNavigation } from './navigation/staticSiteNavigation';
export type { StaticScreen, StaticSiteNavigationConfig } from './navigation/staticSiteNavigation';

// --- the injected backend (spec-222: replaces the engine's old reach into the
//     app's api/http + api/client) ---
export { setGuideBackend, getGuideBackend } from './backend';
export type { GuideBackend } from './backend';

// --- Anthropic-compatible message types the engine owns ---
export type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  MessageParam,
  LlmProxyEvent,
} from './agent-types';

// --- Specky (the visual identity) ---
export { Specky, default as SpeckyDefault } from './components/Specky';
export type { SpeckyProps } from './components/Specky';

// --- the session UX surface (provider + affordances) ---
export {
  VoiceSessionProvider,
  useVoiceSession,
} from './session/VoiceSessionContext';
export type {
  VoiceSessionValue,
  VoiceSessionProviderProps,
} from './session/VoiceSessionContext';
export { VoiceSessionPill } from './session/VoiceSessionPill';
export { VoiceIcon } from './session/VoiceIcon';

// --- the session model (pure types + helpers the app renders against) ---
export {
  initialVoiceSessionState,
  isSessionActive,
  isAffordanceDisabled,
  loopStateLabel,
} from './session/voiceSessionModel';
export type {
  SessionStatus,
  VoiceLoopState,
  Earcon,
  VoiceSessionState,
} from './session/voiceSessionModel';

// --- the orchestrator seam (the t-8 provider drives this) ---
export {
  stubOrchestratorFactory,
} from './session/orchestrator';
export type {
  OrchestratorHooks,
  VoiceOrchestrator,
  OrchestratorFactory,
} from './session/orchestrator';

// --- earcons ---
export { WebAudioEarconPlayer, noopEarconPlayer } from './session/earcons';
export type { EarconPlayer } from './session/earcons';

// --- the live mic→STT→graph→TTS orchestrator factory (built inside the host
//     router tree; the host supplies the NavigationAdapter via the React deps) ---
export { createVoiceOrchestratorFactory } from './orchestrator/voiceGuideOrchestrator';
export type {
  VoiceOrchestratorReactDeps,
  VoiceOrchestratorGlue,
  ScreenContext,
} from './orchestrator/voiceGuideOrchestrator';

// --- the guide graph + client tools (the engine's brain + UI-tool dispatch) ---
export { createGuideGraph, GUIDE_CLIENT_TOOLS } from './guideGraph';
export type {
  GuideStateType,
  GuideCallbacks,
  GuideConfig,
  GuideGraphDeps,
} from './guideGraph';
export {
  executeHighlight,
  executeNavigate,
  executeAdvanceDemo,
  executeStartWalkthrough,
  dispatchGuideUiTool,
  GUIDE_CLIENT_TOOL_NAMES,
} from './guideTools';
export type { NavigateContext, HighlightResult, NavigateResult } from './guideTools';

// --- element resolution + the guide-LLM proxy auth seam ---
export { findGuideElement } from './guideElements';
export { setGuideAuthToken, callGuideLlmProxy } from './guideLlmClient';
export type { GuideScreenElement, GuideLlmInput } from './guideLlmClient';
