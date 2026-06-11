// spec-242 — the first-run controller. Specky opens in TEXT (no cold mic popup),
// running a two-page Specky dialogue sequence over the board:
//
//   Page 1 — mic priming: Specky introduces herself and explains why she needs
//     the mic. "Turn on Mic" fires getUserMedia DIRECTLY (via session.start),
//     and on grant Specky starts speaking; the button only renders if the mic
//     isn't already granted for this browser session. "Not now" is a graceful
//     skip — no voice, no dead end (the Specky avatar stays tappable). The cold
//     browser permission popup never fires on load — only on this explicit press
//     (dec-2 / dec-5; supersedes spec-206's auto-start).
//   Page 2 — "Here's how you get the most out of Memex AI": three info cards
//     (dec-4). Footer "Close" ends the sequence and stamps the one-shot.
//
// The first-run gate is spec-206's server-side one-shot (users.onboarding_greeted_at,
// GET/POST /api/onboarding/greeting). Stamp happens on the final Close (dec-2), so
// a mid-sequence reload re-shows the dialogue.

import { useEffect, useRef, useState } from 'react';
import { useVoiceSession } from '@memex/guide-sdk';
import { fetchGreetingGate, stampGreeting } from '../../api/client';
import { SpeckyDialogue, type SpeckyDialoguePage } from '../specky-dialogue/SpeckyDialogue';
import { ValueIntroPanel, VALUE_INTRO_HEADING } from './ValueIntroPanel';
import { isMicAlreadyGranted } from './micPermission';
import { MicGlyph } from './MicGlyph';

/**
 * The seed context handed to the guide for its proactive opening turn. The guide
 * LLM produces the actual spoken greeting from this seed once the mic is granted
 * (the "Turn on Mic" press calls session.start with it). Carries a warm first-name
 * greeting (or a nameless fallback), the value prop, on-screen orientation, the
 * open invitation, and the demo-walkthrough offer — all "under a minute".
 */
export function buildOnboardingOpeningContext(firstName: string | null): string {
  const greeting = firstName
    ? `Greet the user warmly by their first name, ${firstName}.`
    : `Greet the user warmly — no name is available, so open with a friendly nameless hello (e.g. "Hi there — welcome to Memex!"). Never say a blank or placeholder name.`;
  return [
    `This is the user's very first time in Memex. You are opening the conversation proactively, before they have said anything.`,
    greeting,
    `Then, in under a minute total, give a short spoken welcome that:`,
    `1. Explains what Memex is — a living spec and shared graph that humans and AI coding agents both read and write, so the plan stays live and what's done is proven by CI.`,
    `2. Orients them to what is on screen right now — the Specs board and its phase columns (draft, specify, build, verify, done).`,
    `3. Invites them to ask you about anything they can see on the screen.`,
    `4. Offers to walk them through the demo specs — ask "would you like me to walk you through the demo specs?".`,
    `Keep it warm, concise, and conversational — this is a spoken greeting, not a script reading.`,
  ].join('\n');
}

export function FirstRunGreeting(): React.JSX.Element | null {
  const session = useVoiceSession();
  const [show, setShow] = useState(false);
  const [firstName, setFirstName] = useState<string | null>(null);
  // The "Turn on Mic" button only renders if the mic isn't already granted
  // (dec-5). Probed once on mount; defaults to showing the button.
  const [micAlreadyGranted, setMicAlreadyGranted] = useState(false);
  // Once the user has resolved the mic ask (granted or declined), the action
  // row goes away — Specky doesn't nag (ac-6).
  const [micResolved, setMicResolved] = useState(false);

  // Stamp the one-shot at most once per sequence. (We deliberately DON'T guard the
  // gate fetch with a ref: the GET is idempotent, and a one-shot ref would let
  // StrictMode's first mount cancel mid-fetch while the second mount short-circuits
  // — leaving the dialogue stuck hidden. Mirror WhatsNewRibbon: an `alive` flag and
  // a re-fetch on remount.)
  const stampedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let gate;
      try {
        gate = await fetchGreetingGate();
      } catch {
        return; // gate unreachable → silently skip; never block the board
      }
      if (!alive || !gate.greet) return;
      setFirstName(gate.firstName);
      setShow(true);
      void isMicAlreadyGranted().then((granted) => alive && setMicAlreadyGranted(granted));
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;

  // "Turn on Mic" fires getUserMedia directly (session.start → acquireMic →
  // navigator.mediaDevices.getUserMedia); on grant the orchestrator opens with
  // the seeded greeting, so Specky starts speaking. start() is idempotent and
  // routes a denial to permission_denied without consuming the one-shot.
  const turnOnMic = () => {
    setMicResolved(true);
    void session.start(buildOnboardingOpeningContext(firstName));
  };

  const notNow = () => {
    setMicResolved(true); // graceful skip — no voice; the avatar stays available
  };

  const close = () => {
    setShow(false);
    if (stampedRef.current) return;
    stampedRef.current = true;
    void stampGreeting().catch(() => {
      // Stamp failed — the one-shot survives a network blip; the dialogue may
      // show once more next session rather than being silently lost.
      stampedRef.current = false;
    });
  };

  const showMicAsk = !micAlreadyGranted && !micResolved;

  const pages: SpeckyDialoguePage[] = [
    {
      key: 'mic-priming',
      heading: "Hi, I'm Specky 👋",
      body: (
        <p>
          Your guide inside Memex AI. Ask me anything: where things live, what a status
          means, what to do next. I'll talk you through it. To do any of that, I need your
          mic. Worth it, I promise.
        </p>
      ),
      actions: showMicAsk
        ? [
            {
              label: 'Turn on Mic',
              onSelect: turnOnMic,
              kind: 'primary',
              icon: <MicGlyph />,
              testId: 'turn-on-mic',
            },
            { label: 'Not now', onSelect: notNow, kind: 'quiet', testId: 'mic-not-now' },
          ]
        : undefined,
    },
    {
      key: 'value-intro',
      heading: VALUE_INTRO_HEADING,
      body: <ValueIntroPanel />,
    },
  ];

  return <SpeckyDialogue pages={pages} onClose={close} />;
}
