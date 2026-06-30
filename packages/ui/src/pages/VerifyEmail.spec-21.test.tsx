// @vitest-environment jsdom
// Tests for spec-21 t-3: sign_up_completed dataLayer event gating.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { MemoryRouter } from 'react-router-dom';

const AC7 = 'mindset-prod/memex-website/specs/spec-21/acs/ac-7';

// ── helpers ──────────────────────────────────────────────────────────────────

vi.mock('../api/client', () => ({
  verifyEmailApi: vi.fn(),
  AuthApiError: class AuthApiError extends Error {
    constructor(
      public status: number,
      public reason: string,
      message: string,
    ) { super(message); }
  },
}));

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ acceptSession: vi.fn(), session: null }),
  computeDefaultLanding: () => '/ns/memex/specs',
}));

vi.mock('../components/Confetti', () => ({ Confetti: () => null }));
vi.mock('../components/Spinner', () => ({ Spinner: () => null }));

function dataLayerEvents(): string[] {
  return ((window as Record<string, unknown>).dataLayer as { event?: string }[] | undefined ?? [])
    .map((e) => e.event ?? '')
    .filter(Boolean);
}

function clearDataLayer(): void {
  (window as Record<string, unknown>).dataLayer = [];
}

// Import after mocks are set up
const { verifyEmailApi } = await import('../api/client');
const { VerifyEmail } = await import('./VerifyEmail');

// ── tests ────────────────────────────────────────────────────────────────────

describe('VerifyEmail — sign_up_completed gating (spec-21 t-3)', () => {
  beforeEach(() => {
    clearDataLayer();
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearDataLayer();
  });

  it('pushes sign_up_completed to dataLayer when isNewAccount is true', async () => {
    tagAc(AC7);
    vi.mocked(verifyEmailApi).mockResolvedValueOnce({
      user: { id: 'u1', email: 'new@example.com', name: null, status: 'active', emailVerified: true },
      memberships: [],
      currentMemexId: null,
      currentRole: null,
      needsOnboarding: false,
      hiddenFeatures: [],
      isNewAccount: true,
    });

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/?token=tok1']}>
          <VerifyEmail />
        </MemoryRouter>,
      );
    });

    expect(dataLayerEvents()).toContain('sign_up_completed');
  });

  it('does NOT push sign_up_completed when isNewAccount is false (returning user)', async () => {
    tagAc(AC7);
    vi.mocked(verifyEmailApi).mockResolvedValueOnce({
      user: { id: 'u2', email: 'existing@example.com', name: null, status: 'active', emailVerified: true },
      memberships: [],
      currentMemexId: null,
      currentRole: null,
      needsOnboarding: false,
      hiddenFeatures: [],
      isNewAccount: false,
    });

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/?token=tok2']}>
          <VerifyEmail />
        </MemoryRouter>,
      );
    });

    expect(dataLayerEvents()).not.toContain('sign_up_completed');
  });

  it('uses the server-provided conversionEventId as the dataLayer event_id', async () => {
    tagAc(AC7);
    vi.mocked(verifyEmailApi).mockResolvedValueOnce({
      user: { id: 'u4', email: 'new2@example.com', name: null, status: 'active', emailVerified: true },
      memberships: [],
      currentMemexId: null,
      currentRole: null,
      needsOnboarding: false,
      hiddenFeatures: [],
      isNewAccount: true,
      conversionEventId: 'server-event-id-123',
    });

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/?token=tok4']}>
          <VerifyEmail />
        </MemoryRouter>,
      );
    });

    const dl = ((window as Record<string, unknown>).dataLayer as Record<string, unknown>[] | undefined ?? []);
    const completedEvent = dl.find((e) => e.event === 'sign_up_completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent!.event_id).toBe('server-event-id-123');
  });

  it('does NOT push sign_up_completed when isNewAccount is absent', async () => {
    tagAc(AC7);
    vi.mocked(verifyEmailApi).mockResolvedValueOnce({
      user: { id: 'u3', email: 'login@example.com', name: null, status: 'active', emailVerified: true },
      memberships: [],
      currentMemexId: null,
      currentRole: null,
      needsOnboarding: false,
      hiddenFeatures: [],
    });

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/?token=tok3']}>
          <VerifyEmail />
        </MemoryRouter>,
      );
    });

    expect(dataLayerEvents()).not.toContain('sign_up_completed');
  });
});
