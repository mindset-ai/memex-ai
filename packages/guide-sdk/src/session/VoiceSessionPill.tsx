// spec-190 t-8 (dec-5 / ac-29 / ac-31) — the floating session pill. Shown while a
// session is active; persists across route changes (it's rendered once at the
// app-shell level by VoiceLayer, independent of the routed page). It:
//   - reflects the live voice-loop state (listening / acknowledged / thinking /
//     speaking / ducked / muted) — ac-29;
//   - supports tap-to-interrupt on its body (manual barge-in fallback) — ac-29/ac-5;
//   - offers mute and end controls at all times — ac-29;
//   - renders NO transcript (v1 keeps none — ac-31).

import { useVoiceSession } from './VoiceSessionContext';
import { loopStateLabel } from './voiceSessionModel';
import { Specky } from '../components/Specky';

export function VoiceSessionPill(): React.JSX.Element {
  const session = useVoiceSession();
  const label = loopStateLabel(session);
  const ducked = session.loopState === 'ducked';

  return (
    <div
      data-voice-pill
      data-loop-state={session.loopState}
      className="flex items-center gap-2 rounded-full bg-surface px-3 py-2 shadow-lg ring-1 ring-border"
    >
      {/* Tap the body to interrupt the agent mid-speech (ac-29 / ac-5). */}
      <button
        type="button"
        data-voice-interrupt
        aria-label="Tap to interrupt"
        onClick={session.interrupt}
        className="flex items-center gap-2"
      >
        {/* spec-197: the animated Specky avatar — present + alive (idle loop,
            dec-1=a). It does NOT change per session state; the StateBlip beside
            it conveys listening/thinking/speaking, so Specky stays a single idle
            character (ac-7). Decorative — the state label carries the meaning. */}
        <Specky size={30} />
        <StateBlip loopState={session.loopState} />
        <span className={`text-sm ${ducked ? 'opacity-70' : ''}`} data-voice-state-label>
          {label}
        </span>
      </button>

      <div className="ml-1 flex items-center gap-1">
        {/* Explicit Stop — appears the moment the agent has audio to interrupt
            (speaking or ducked). Gives the user deliberate, discoverable control
            without waiting on the VAD-driven barge-in; same hard-cut path as the
            body tap (session.interrupt → orchestrator.interrupt → tapInterrupt). */}
        {(session.loopState === 'speaking' || session.loopState === 'ducked') && (
          <button
            type="button"
            data-voice-stop
            aria-label="Stop the guide"
            title="Stop"
            onClick={session.interrupt}
            className="rounded-full p-1 text-accent hover:bg-surface-hover"
          >
            <span aria-hidden className="block h-3 w-3 rounded-[2px] bg-current" />
          </button>
        )}
        <button
          type="button"
          data-voice-end
          aria-label="End voice session"
          title="End session"
          onClick={session.end}
          className="rounded-full p-1 text-text-secondary hover:bg-surface-hover"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** The ack blip syncs to the dec-6 ping; here it's the visual pulse keyed to
 *  loop state. The 'acknowledged' state is the blink that fires with the ping. */
function StateBlip({
  loopState,
}: {
  loopState: string;
}): React.JSX.Element {
  const pulsing = loopState === 'listening' || loopState === 'acknowledged' || loopState === 'speaking';
  const color =
    loopState === 'speaking'
      ? 'bg-accent'
      : loopState === 'thinking'
        ? 'bg-amber-400'
        : 'bg-emerald-400';
  return (
    <span
      data-voice-blip
      className={`inline-block h-2.5 w-2.5 rounded-full ${color} ${pulsing ? 'animate-pulse' : ''}`}
      aria-hidden="true"
    />
  );
}
