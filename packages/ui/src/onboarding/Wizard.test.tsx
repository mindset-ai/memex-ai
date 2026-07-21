import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-502:
//   ac-7  — cannot reach first-spec without connect OR the explicit defer branch;
//           no equal-footing in-browser authoring alternative at the connect step.
//   ac-8  — defer, not lose: a resume/email branch that keeps the Memex.
//   ac-13 — lands on the created spec via the spec-482 path (?new=1).
//   ac-15 — reuses the salvaged connect step (CreateSpecStep), not a duplicate.
const AC_GATE = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-7';
const AC_DEFER = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-8';
const AC_LAND = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-13';
const AC_REUSE = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-15';
const AC_POPULATED = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-4';
const AC_ADOPT = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-11';
const AC_SPINE = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-2';
const AC_NO_DEADEND = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-3';

// Stub the salvaged connect step so we don't hit its journey-state polling; it
// exposes a button that fires onComplete (the observed-MCP-traffic latch).
vi.mock('../components/home/CreateSpecStep', () => ({
  CreateSpecStep: ({ onComplete }: { onComplete?: () => void }) => (
    <div data-testid="reused-create-spec-step">
      <button data-testid="simulate-connected" onClick={() => onComplete?.()}>
        simulate connect
      </button>
    </div>
  ),
}));

const track = vi.fn();
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track, optedOut: false, setOptOut: vi.fn() }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    session: {
      user: { email: 'a@b.co' },
      memberships: [
        { kind: 'personal', slug: 'alice', memexSlug: 'personal', memexId: 'mx-1', name: 'Alice' },
      ],
    },
  }),
}));

import { Wizard } from './Wizard';

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={['/wizard']}>
      <Wizard />
    </MemoryRouter>,
  );
}

// Drive the wizard from the name step to the connect step.
function advanceToConnect() {
  fireEvent.click(screen.getByTestId('wizard-name-continue'));
  fireEvent.click(screen.getByTestId('wizard-demo-continue'));
}

describe('spec-502 Wizard', () => {
  beforeEach(() => {
    track.mockClear();
    navigate.mockClear();
  });

  it('ac-15/ac-2: drives every user name → demo → connect (the spine), reusing CreateSpecStep', () => {
    tagAc(AC_REUSE);
    tagAc(AC_SPINE); // the wizard actively drives to the connect step — not an optional card
    renderWizard();
    // name → memex_named
    fireEvent.click(screen.getByTestId('wizard-name-continue'));
    expect(track).toHaveBeenCalledWith('wizard.memex_named');
    // demo → demo_viewed
    expect(screen.getByTestId('wizard-console-demo')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('wizard-demo-continue'));
    expect(track).toHaveBeenCalledWith('wizard.demo_viewed');
    // connect → reached_connect, and the reused step is mounted
    expect(track).toHaveBeenCalledWith('wizard.reached_connect');
    expect(screen.getByTestId('reused-create-spec-step')).toBeInTheDocument();
  });

  it('ac-7: the connect step offers no equal-footing in-browser authoring fork', () => {
    tagAc(AC_GATE);
    renderWizard();
    advanceToConnect();
    // The only forward paths are: connect, or the explicit defer branch.
    expect(screen.queryByRole('button', { name: /in the browser|author here|skip the agent|do it here/i })).toBeNull();
    expect(screen.getByTestId('wizard-defer-connect')).toBeInTheDocument();
  });

  it('ac-13/ac-4/ac-11: a real connect lands on the user\'s OWN spec board via ?new=1', () => {
    tagAc(AC_LAND);
    tagAc(AC_POPULATED); // lands on the spec board (populated by the agent), not an empty screen
    tagAc(AC_ADOPT); // targets the existing personal Memex — mints none
    renderWizard();
    advanceToConnect();
    fireEvent.click(screen.getByTestId('simulate-connected'));
    // The user's existing personal Memex (alice/personal) — no new memex minted.
    expect(navigate).toHaveBeenCalledWith('/alice/personal/specs?new=1');
  });

  it('ac-8/ac-3: the defer branch keeps the Memex and lands the user in it (no dead-end)', () => {
    tagAc(AC_DEFER);
    tagAc(AC_NO_DEADEND); // the connect step never dead-ends — capture/resume, not dropped
    renderWizard();
    advanceToConnect();
    fireEvent.click(screen.getByTestId('wizard-defer-connect'));
    // Lands in their own (preserved) Memex — not a dead end.
    expect(navigate).toHaveBeenCalledWith('/alice/personal/specs');
    expect(track).toHaveBeenCalledWith('wizard.reached_connect', { deferred: true });
  });
});
