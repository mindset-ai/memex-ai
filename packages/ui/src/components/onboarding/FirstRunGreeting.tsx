// spec-206 t-3 — the first-run greeting controller.
//
// On a user's first session, Specky initiates the conversation ITSELF — no modal,
// no tap (ac-1). This component (mounted inside VoiceGuideMount, so it has the
// voice session + the shared reveal pointer in scope) does four things:
//
//   1. On board mount, asks the server whether to greet (GET /api/onboarding/greeting).
//   2. If greet && audio is available, auto-starts the voice session seeded with the
//      onboarding opening context — Specky opens by greeting + explaining (dec-1/dec-2).
//   3. If audio is unavailable (no mic / denied / no key), it no-ops — the user just
//      lands on the board (dec-4 / ac-15). The flag is left null so a later session
//      can still greet.
//   4. Stamps onboarding_greeted_at ONLY once the session actually reaches `active`
//      (dec-4 / ac-16) — a blocked/denied start never consumes the one-shot.
//
// Renders nothing — it's a behavioural controller, like WhatsNewRibbonConnected.

import { useEffect, useRef } from 'react';
import { useVoiceSession } from '../../voice/session/VoiceSessionContext';
import { isAffordanceDisabled } from '../../voice/session/voiceSessionModel';
import { fetchGreetingGate, stampGreeting } from '../../api/client';

/**
 * The seed context handed to the guide for its proactive opening turn (dec-2).
 * The guide LLM produces the actual spoken greeting from this brief. Encodes:
 * a warm first-name greeting (or a nameless fallback), the value prop, on-screen
 * orientation, the open invitation, and the demo-walkthrough offer — all "under a
 * minute" (ac-2 / ac-3 / ac-10 / ac-11).
 */
export function buildOnboardingOpeningContext(firstName: string | null): string {
  const greeting = firstName
    ? `Greet the user warmly by their first name, ${firstName}.`
    : `Greet the user warmly — no name is available, so open with a friendly nameless hello (e.g. "Hi there — welcome to Memex!"). Never say a blank or placeholder name.`;
  return [
    `This is the user's very first time in Memex. You are opening the conversation proactively, before they have said anything.`,
    greeting,
    `Then, in under a minute total, give a brief spoken welcome that:`,
    `1. Explains what Memex is — a living spec and shared graph that humans and AI coding agents both read and write, so the plan stays live and what's done is proven by CI.`,
    `2. Orients them to what is on screen right now — the Specs board and its phase columns (draft, specify, build, verify, done).`,
    `3. Invites them to ask you about anything they can see on the screen.`,
    `4. Offers to walk them through the demo specs — ask "would you like me to walk you through the demo specs?".`,
    `Keep it warm, concise, and conversational — this is a spoken greeting, not a script reading.`,
  ].join('\n');
}

export function FirstRunGreeting(): null {
  const session = useVoiceSession();
  const { start, status, micAvailable } = session;
  // Guard one-shots: we auto-start at most once, and stamp at most once — and only
  // for a greeting WE initiated (a user-started session must never stamp the flag).
  const startedRef = useRef(false);
  const stampedRef = useRef(false);

  // 1–3: check the gate once on mount and auto-start when eligible + audible.
  useEffect(() => {
    if (startedRef.current) return;
    // Audio can't run → no-op, land on board (ac-15). Don't even hit the gate, so
    // the one-shot is preserved for a later session that does have a mic.
    if (isAffordanceDisabled({ status, micAvailable } as Parameters<typeof isAffordanceDisabled>[0])) {
      return;
    }
    let cancelled = false;
    void (async () => {
      let gate;
      try {
        gate = await fetchGreetingGate();
      } catch {
        return; // gate unreachable → silently skip; never block the board
      }
      if (cancelled || !gate.greet || startedRef.current) return;
      startedRef.current = true;
      // start() itself requests mic permission; a denial routes to permission_denied
      // (not active), so the stamp effect below won't fire — the one-shot survives.
      void start(buildOnboardingOpeningContext(gate.firstName));
    })();
    return () => {
      cancelled = true;
    };
    // Mount-once: live status is read by the stamp effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 4: stamp only once the greeting actually starts speaking (status → active).
  useEffect(() => {
    if (!startedRef.current || stampedRef.current) return;
    if (status === 'active') {
      stampedRef.current = true;
      void stampGreeting().catch(() => {
        // Stamp failed — allow a retry on a later 'active' transition rather than
        // burning the one-shot on a network blip.
        stampedRef.current = false;
      });
    }
  }, [status]);

  return null;
}
