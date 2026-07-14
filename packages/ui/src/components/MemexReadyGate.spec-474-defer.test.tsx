// @vitest-environment jsdom
// spec-474 dec-6 regression — the first-load readiness gate ("Getting your Memex ready…")
// must DEFER to email verification. A just-signed-up user is admitted with
// emailVerified=false; the readiness gate must not provision or show its blocker for that
// user, or the blocker pre-empts the "Confirm your email" screen (VerifyEmailGate) that the
// routes render inside `children`. Provisioning may only run once the session flips to
// verified.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// Hoisted so the (hoisted) vi.mock factory can close over the same spies we assert on.
const { fetchProvisionedMock, provisionMock } = vi.hoisted(() => ({
  fetchProvisionedMock: vi.fn(),
  provisionMock: vi.fn(),
}));

vi.mock('../api/provision', () => ({
  fetchPersonalMemexProvisioned: fetchProvisionedMock,
  provisionPersonalMemex: provisionMock,
}));

const BLOCKER = 'Getting your Memex ready…';

// The gate keeps a module-level `knownReady` latch that survives across renders. Re-import
// it fresh per test (after resetModules) so each case starts from a clean, un-latched state.
async function loadGate() {
  vi.resetModules();
  const mod = await import('./MemexReadyGate');
  return mod.MemexReadyGate;
}

describe('MemexReadyGate — defers readiness until email verified (spec-474 dec-6)', () => {
  beforeEach(() => {
    fetchProvisionedMock.mockReset();
    provisionMock.mockReset();
    // Default: a brand-new, unprovisioned personal Memex.
    fetchProvisionedMock.mockResolvedValue(false);
    provisionMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders children and never provisions while the email is unverified', async () => {
    const MemexReadyGate = await loadGate();
    await act(async () => {
      render(
        <MemexReadyGate emailVerified={false}>
          <div>app content</div>
        </MemexReadyGate>,
      );
    });

    // The "Confirm your email" screen (part of children) shows — not the readiness blocker.
    expect(screen.getByText('app content')).toBeTruthy();
    expect(screen.queryByText(BLOCKER)).toBeNull();
    // And no readiness work fired: no GET /me, no POST /me/provision.
    expect(fetchProvisionedMock).not.toHaveBeenCalled();
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it('provisions behind the blocker once the email is verified', async () => {
    const MemexReadyGate = await loadGate();
    await act(async () => {
      render(
        <MemexReadyGate emailVerified={true}>
          <div>app content</div>
        </MemexReadyGate>,
      );
    });

    await waitFor(() => expect(provisionMock).toHaveBeenCalledTimes(1));
    expect(fetchProvisionedMock).toHaveBeenCalledTimes(1);
    // After the seed completes the app renders.
    await waitFor(() => expect(screen.getByText('app content')).toBeTruthy());
  });

  it('kicks off provisioning when the session flips unverified → verified', async () => {
    const MemexReadyGate = await loadGate();
    const { rerender } = render(
      <MemexReadyGate emailVerified={false}>
        <div>app content</div>
      </MemexReadyGate>,
    );
    // Nothing provisions while unverified.
    expect(fetchProvisionedMock).not.toHaveBeenCalled();
    expect(provisionMock).not.toHaveBeenCalled();

    // The user clicks the verification link; VerifyEmailGate's poll refreshes the session
    // and it comes back verified, re-rendering this gate with emailVerified=true.
    await act(async () => {
      rerender(
        <MemexReadyGate emailVerified={true}>
          <div>app content</div>
        </MemexReadyGate>,
      );
    });

    await waitFor(() => expect(provisionMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('app content')).toBeTruthy());
  });
});
