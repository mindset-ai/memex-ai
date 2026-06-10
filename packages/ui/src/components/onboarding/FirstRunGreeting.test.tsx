// spec-206 t-3 — the first-run greeting controller.
//
// Unit: the opening-context builder carries the required beats (ac-2/3/10/11).
// Integration: against a REAL VoiceSessionProvider (injected mic/orchestrator), the
// controller auto-starts on a first session with no tap (ac-1), stamps only once the
// session reaches `active` (ac-16), and no-ops when audio is unavailable (ac-15).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, waitFor } from '@testing-library/react';

// Mock the user-level greeting API the controller calls.
const fetchGreetingGate = vi.fn();
const stampGreeting = vi.fn();
vi.mock('../../api/client', () => ({
  fetchGreetingGate: () => fetchGreetingGate(),
  stampGreeting: () => stampGreeting(),
}));

import { FirstRunGreeting, buildOnboardingOpeningContext } from './FirstRunGreeting';
import {
  VoiceSessionProvider,
  noopEarconPlayer,
  type OrchestratorFactory,
} from '@memex/guide-sdk';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-206/acs/ac-${n}`;

// Records the opening context the provider hands the orchestrator on start().
let recordedOpening: string | undefined;
const recordingFactory: OrchestratorFactory = (hooks) => ({
  start: async (_stream, opening) => {
    recordedOpening = opening;
  },
  interrupt: () => {},
  stop: () => {},
  narratePhase: () => hooks.onTurnComplete?.(),
});

const fakeStream = { getTracks: () => [] } as unknown as MediaStream;

function renderController(opts: { micAvailable: boolean; grant?: boolean }) {
  return render(
    <VoiceSessionProvider
      orchestratorFactory={recordingFactory}
      earcons={noopEarconPlayer}
      detectMic={() => opts.micAvailable}
      getUserMedia={async () => {
        if (opts.grant === false) throw new Error('denied');
        return fakeStream;
      }}
    >
      <FirstRunGreeting />
    </VoiceSessionProvider>,
  );
}

beforeEach(() => {
  fetchGreetingGate.mockReset();
  stampGreeting.mockReset();
  recordedOpening = undefined;
});

describe('buildOnboardingOpeningContext (spec-206 ac-2/3/10/11)', () => {
  it('greets by first name and carries the value prop, orientation, invite, and offer', () => {
    const ctx = buildOnboardingOpeningContext('Ryan');
    expect(ctx).toContain('Ryan'); // ac-10: greet by first name
    expect(ctx.toLowerCase()).toContain('living spec'); // ac-2: value prop
    expect(ctx.toLowerCase()).toContain('phase columns'); // ac-2: on-screen orientation
    expect(ctx.toLowerCase()).toContain('ask'); // ac-3: invite questions
    expect(ctx.toLowerCase()).toContain('walk you through the demo specs'); // ac-3: offer
    expect(ctx.toLowerCase()).toContain('under a minute'); // ac-2: brevity
    tagAc(AC(2));
    tagAc(AC(3));
    tagAc(AC(10));
  });

  it('uses a warm nameless fallback when no name is available, never a placeholder', () => {
    const ctx = buildOnboardingOpeningContext(null);
    expect(ctx.toLowerCase()).toContain('hi there'); // warm nameless hello
    expect(ctx).not.toMatch(/\bnull\b/); // never a placeholder/empty name
    expect(ctx).not.toContain('undefined');
    tagAc(AC(11));
  });
});

describe('FirstRunGreeting controller', () => {
  it('auto-starts the greeting on a first session (no tap) and stamps once active', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: true, firstName: 'Ryan' });
    stampGreeting.mockResolvedValue(undefined);

    renderController({ micAvailable: true, grant: true });

    // No user interaction — the controller drives it (ac-1).
    await waitFor(() => expect(fetchGreetingGate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recordedOpening).toContain('Ryan'));
    // Session reached `active` → the flag is stamped exactly once (ac-16).
    await waitFor(() => expect(stampGreeting).toHaveBeenCalledTimes(1));
    tagAc(AC(1));
    tagAc(AC(16));
  });

  it('no-ops when audio is unavailable — never greets, never stamps (ac-15)', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: true, firstName: 'Ryan' });

    renderController({ micAvailable: false });

    // Give any async effects a chance to (not) run.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchGreetingGate).not.toHaveBeenCalled(); // gate not even hit
    expect(recordedOpening).toBeUndefined(); // session never started
    expect(stampGreeting).not.toHaveBeenCalled(); // one-shot preserved
    tagAc(AC(15));
  });

  it('does not greet a returning user (greet=false) and does not stamp', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: false, firstName: 'Ryan' });

    renderController({ micAvailable: true, grant: true });

    await waitFor(() => expect(fetchGreetingGate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(recordedOpening).toBeUndefined();
    expect(stampGreeting).not.toHaveBeenCalled();
  });

  it('does not stamp the one-shot when mic permission is denied (ac-16)', async () => {
    fetchGreetingGate.mockResolvedValue({ greet: true, firstName: 'Ryan' });

    renderController({ micAvailable: true, grant: false });

    await waitFor(() => expect(fetchGreetingGate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    // start() was attempted but permission was denied → never `active` → no stamp.
    expect(stampGreeting).not.toHaveBeenCalled();
  });
});
