// spec-242 — the two-page first-run sequence + the value panel.
//
// Proves: Specky opens in TEXT with the mic-priming page and NEVER calls
// getUserMedia on load (dec-2 / ac-1 / ac-9 / ac-11 / ac-14); "Turn on Mic"
// fires session.start → getUserMedia only on the press (dec-5 / ac-15); the
// button renders only when the mic isn't already granted (ac-16); "Not now"
// starts no voice (ac-17); the sequence pages mic → value and stamps the
// one-shot on the final Close (dec-6 / ac-18 / ac-10 / ac-5); and the value
// panel is three static info cards, not a checklist (ac-13 / ac-3 / ac-4).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const fetchGreetingGate = vi.fn();
const stampGreeting = vi.fn();
vi.mock('../../api/client', () => ({
  fetchGreetingGate: () => fetchGreetingGate(),
  stampGreeting: () => stampGreeting(),
}));

const isMicAlreadyGranted = vi.fn();
vi.mock('./micPermission', () => ({
  isMicAlreadyGranted: () => isMicAlreadyGranted(),
}));

import { FirstRunGreeting } from './FirstRunGreeting';
import { ValueIntroPanel, VALUE_INTRO_HEADING, VALUE_INTRO_ITEMS } from './ValueIntroPanel';
import {
  VoiceSessionProvider,
  noopEarconPlayer,
  type OrchestratorFactory,
} from '@memex/guide-sdk';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-242/acs/ac-${n}`;

let orchestratorStarted = false;
const recordingFactory: OrchestratorFactory = () => ({
  start: async () => {
    orchestratorStarted = true;
  },
  interrupt: () => {},
  stop: () => {},
});

const getUserMediaSpy = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);

function renderController() {
  return render(
    <VoiceSessionProvider
      orchestratorFactory={recordingFactory}
      earcons={noopEarconPlayer}
      detectMic={() => true}
      getUserMedia={getUserMediaSpy}
    >
      <FirstRunGreeting />
    </VoiceSessionProvider>,
  );
}

beforeEach(() => {
  fetchGreetingGate.mockReset();
  stampGreeting.mockReset();
  getUserMediaSpy.mockClear();
  isMicAlreadyGranted.mockReset();
  isMicAlreadyGranted.mockResolvedValue(false);
  orchestratorStarted = false;
});

describe('FirstRunGreeting — first-run sequence (spec-242 dec-2/dec-5/dec-6)', () => {
  it('opens on the mic-priming page in text, with no getUserMedia / voice on load (ac-9 / ac-11 / ac-14)', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: true, firstName: 'Ryan' });

    renderController();

    // Page 1 is the mic-priming page — Specky introduces herself in text.
    await waitFor(() => expect(screen.getByTestId('specky-dialogue')).toBeInTheDocument());
    expect(screen.getByText(/Hi, I'm Specky/)).toBeInTheDocument();
    expect(screen.getByTestId('turn-on-mic')).toBeInTheDocument();
    expect(screen.getByTestId('mic-not-now')).toBeInTheDocument();

    // Mic is available, yet nothing auto-started: no getUserMedia, no orchestrator.
    await new Promise((r) => setTimeout(r, 30));
    expect(getUserMediaSpy).not.toHaveBeenCalled();
    expect(orchestratorStarted).toBe(false);

    tagAc(AC(9));
    tagAc(AC(11));
    tagAc(AC(1)); // scope: no mic prompt fires on load
    tagAc(AC(14)); // scope: Specky introduces herself + Turn on Mic / Not now
  });

  it('"Turn on Mic" fires session.start → getUserMedia, only on the press (ac-15)', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: true, firstName: 'Ryan' });

    renderController();
    await waitFor(() => expect(screen.getByTestId('turn-on-mic')).toBeInTheDocument());

    expect(getUserMediaSpy).not.toHaveBeenCalled(); // not before the press
    fireEvent.click(screen.getByTestId('turn-on-mic'));

    // start() requests the mic and, on grant, runs the seeded opening turn.
    await waitFor(() => expect(getUserMediaSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(orchestratorStarted).toBe(true));

    tagAc(AC(15));
  });

  it('renders "Turn on Mic" only when the mic is not already granted (ac-16)', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: true, firstName: 'Ryan' });
    isMicAlreadyGranted.mockResolvedValue(true);

    renderController();
    await waitFor(() => expect(screen.getByTestId('specky-dialogue')).toBeInTheDocument());
    // Already granted → the button never appears.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('turn-on-mic')).toBeNull();
    expect(screen.queryByTestId('mic-not-now')).toBeNull();

    tagAc(AC(16));
  });

  it('"Not now" dismisses the ask without starting voice — no dead end (ac-17)', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: true, firstName: 'Ryan' });

    renderController();
    await waitFor(() => expect(screen.getByTestId('mic-not-now')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('mic-not-now'));

    // No voice started; the buttons clear (no nagging) but the dialogue stays.
    await new Promise((r) => setTimeout(r, 30));
    expect(getUserMediaSpy).not.toHaveBeenCalled();
    expect(orchestratorStarted).toBe(false);
    expect(screen.queryByTestId('turn-on-mic')).toBeNull();
    expect(screen.getByTestId('specky-dialogue')).toBeInTheDocument();

    tagAc(AC(17));
    tagAc(AC(6)); // scope: never a dead end
  });

  it('pages mic → value, then Close ends the sequence and stamps the one-shot once (ac-18 / ac-10)', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: true, firstName: 'Ryan' });
    stampGreeting.mockResolvedValue(undefined);

    renderController();
    await waitFor(() => expect(screen.getByText(/Hi, I'm Specky/)).toBeInTheDocument());

    // Page 1 footer is Next (not the final page) → advancing shows the value panel.
    const footer = screen.getByTestId('specky-dialogue-footer');
    expect(footer).toHaveTextContent('Next');
    expect(stampGreeting).not.toHaveBeenCalled();
    fireEvent.click(footer);

    await waitFor(() => expect(screen.getByText(VALUE_INTRO_HEADING)).toBeInTheDocument());

    // Page 2 footer is Close → ends + stamps exactly once.
    const closer = screen.getByTestId('specky-dialogue-footer');
    expect(closer).toHaveTextContent('Close');
    fireEvent.click(closer);
    expect(screen.queryByTestId('specky-dialogue')).toBeNull();
    await waitFor(() => expect(stampGreeting).toHaveBeenCalledTimes(1));

    tagAc(AC(18));
    tagAc(AC(10));
    tagAc(AC(5)); // scope: one-shot consumed on close
  });

  it('does not show the sequence (and never stamps) for an already-greeted user', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: false, firstName: 'Ryan' });

    renderController();
    await waitFor(() => expect(fetchGreetingGate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('specky-dialogue')).toBeNull();
    expect(stampGreeting).not.toHaveBeenCalled();

    tagAc(AC(5));
  });
});

describe('ValueIntroPanel (spec-242 dec-4)', () => {
  it('renders exactly three numbered info cards with the design copy, and nothing interactive (ac-13 / ac-3)', () => {
    render(<ValueIntroPanel />);
    const panel = screen.getByTestId('value-intro-panel');

    const headings = within(panel).getAllByRole('heading');
    expect(headings).toHaveLength(3);
    expect(headings[0]).toHaveTextContent('1. Connect your coding agent');
    expect(headings[1]).toHaveTextContent('2. Walk through the demo spec');
    expect(headings[2]).toHaveTextContent('3. Work with your team');
    expect(panel).toHaveTextContent('ready and waiting for you to try in the draft column');
    expect(panel.querySelectorAll('a, button, input')).toHaveLength(0);

    tagAc(AC(13));
    tagAc(AC(3));
  });

  it('frames the MCP card builder-first: it opens with "If you write code, do this first." (ac-4)', () => {
    expect(VALUE_INTRO_ITEMS[0].body.startsWith('If you write code, do this first.')).toBe(true);
    render(<ValueIntroPanel />);
    expect(screen.getByTestId('value-intro-panel')).toHaveTextContent(
      'If you write code, do this first.',
    );

    tagAc(AC(4));
  });
});
