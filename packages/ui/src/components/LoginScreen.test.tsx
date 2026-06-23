// spec-304 t-40 (ac-30) — the "check your email" view completes login IN PLACE.
//
// Component-level proof that the LoginScreen, once it shows the magic-sent view,
// captures the issue response's loginRequestId, polls login-request status, and
// — on verified — adopts the session through the SAME callback the rest of auth
// uses (in the app that's AuthContext's `acceptSession`). We drive the full
// identifier-first path: enter email → probe says "Google-only" → magic link
// issued → poll pending → poll verified → onMagicLinkVerified fires once.
//
// The network is mocked at the api-client layer (same layer the app's other
// component tests mock), keeping the real NotFoundError so the 404 branch hits
// the actual error class. Fake timers drive the poll interval deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ReactNode } from 'react';
import type { SessionPayload } from '../api/client';

vi.mock('@react-oauth/google', () => ({
  GoogleOAuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  GoogleLogin: () => <button data-testid="google-login">Mock Google Login</button>,
}));

const probeAuthApi = vi.fn();
const magicLinkRequestApi = vi.fn();
const magicLinkStatusApi = vi.fn();
const trackAnonymous = vi.fn();

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    probeAuthApi: (...a: unknown[]) => probeAuthApi(...a),
    magicLinkRequestApi: (...a: unknown[]) => magicLinkRequestApi(...a),
    magicLinkStatusApi: (...a: unknown[]) => magicLinkStatusApi(...a),
  };
});

// Spy the pre-auth ingress call so the signup.form_viewed assertion needs no
// network; everything else in the telemetry module stays real.
vi.mock('../hooks/useTelemetry', async () => {
  const actual =
    await vi.importActual<typeof import('../hooks/useTelemetry')>('../hooks/useTelemetry');
  return { ...actual, trackAnonymous: (...a: unknown[]) => trackAnonymous(...a) };
});

import { LoginScreen } from './LoginScreen';
import { MAGIC_LINK_POLL_INTERVAL_MS } from '../hooks/useMagicLinkPoll';
import { NotFoundError } from '../api/client';

const AC = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-30';
const AC324 = 'mindset-prod/memex-building-itself/specs/spec-324/acs';
const AC326 = 'mindset-prod/memex-building-itself/specs/spec-326/acs';
const AC367 = 'mindset-prod/memex-building-itself/specs/spec-367/acs';
const REQUEST_ID = 'lr_xyz789';
const EMAIL = 'user@example.com';

function fakeSession(): SessionPayload {
  return {
    user: { id: 'u-1', email: EMAIL, name: 'User', status: 'active', emailVerified: true },
    memberships: [],
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures: [],
    token: 'jwt-from-poll',
  };
}

function renderLogin(onMagicLinkVerified = vi.fn()) {
  render(
    <LoginScreen
      authError={null}
      googleClientId="test-client-id"
      onSignup={vi.fn()}
      onLogin={vi.fn()}
      onMagicLink={(email) => magicLinkRequestApi(email)}
      onMagicLinkVerified={onMagicLinkVerified}
      onPasswordReset={vi.fn()}
      onGoogleCredential={vi.fn()}
    />,
  );
  return { onMagicLinkVerified };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Drive enter-email → magic-sent. probeAuthApi resolves "exists, no password" so
// the Continue handler issues a magic link and lands on the magic-sent view.
async function reachMagicSent(): Promise<void> {
  probeAuthApi.mockResolvedValue({ exists: true, hasPassword: false });
  magicLinkRequestApi.mockResolvedValue({ loginRequestId: REQUEST_ID });

  const input = screen.getByPlaceholderText('you@company.com');
  await act(async () => {
    fireEvent.change(input, { target: { value: EMAIL } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
  await flush();
}

describe('LoginScreen magic-link polling [spec-304 t-40 / ac-30]', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probeAuthApi.mockReset();
    magicLinkRequestApi.mockReset();
    magicLinkStatusApi.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('issuing a link captures loginRequestId and the magic-sent view starts polling', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockResolvedValue({ verified: false, expired: false });
    renderLogin();

    await reachMagicSent();

    // The view tells the user to check their email…
    expect(screen.getByText('Check your email')).toBeInTheDocument();
    expect(
      screen.getByText(`We sent a sign-in link to ${EMAIL}. It expires in 15 minutes.`),
    ).toBeInTheDocument();
    // …and the captured loginRequestId is being polled.
    expect(magicLinkStatusApi).toHaveBeenCalledWith(REQUEST_ID);
  });

  it('poll pending → verified: adopts the session exactly once and shows the signed-in state', async () => {
    tagAc(AC);
    const session = fakeSession();
    magicLinkStatusApi
      .mockResolvedValueOnce({ verified: false, expired: false }) // immediate poll
      .mockResolvedValueOnce({ verified: true, ...session }); // next tick → verified

    const { onMagicLinkVerified } = renderLogin();
    await reachMagicSent();

    expect(onMagicLinkVerified).not.toHaveBeenCalled();
    expect(screen.getByText('Check your email')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS);
    });
    await flush();

    // Session adopted via the same callback as password/SSO/consume login, once,
    // with the `verified` discriminator stripped.
    expect(onMagicLinkVerified).toHaveBeenCalledTimes(1);
    expect(onMagicLinkVerified).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'jwt-from-poll' }),
    );
    expect(onMagicLinkVerified.mock.calls[0][0]).not.toHaveProperty('verified');
    expect(screen.getByText('Signed in')).toBeInTheDocument();
  });

  it('verified is single-shot: no further poll fires and onMagicLinkVerified stays at one call', async () => {
    tagAc(AC);
    const session = fakeSession();
    magicLinkStatusApi.mockResolvedValue({ verified: true, ...session });

    const { onMagicLinkVerified } = renderLogin();
    await reachMagicSent();

    expect(onMagicLinkVerified).toHaveBeenCalledTimes(1);
    const callsAfterVerify = magicLinkStatusApi.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 4);
    });
    await flush();

    expect(magicLinkStatusApi).toHaveBeenCalledTimes(callsAfterVerify); // no extra polls
    expect(onMagicLinkVerified).toHaveBeenCalledTimes(1);
  });

  it('expired surrogate → error state offering a new link, polling stops, no adoption', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockResolvedValue({ verified: false, expired: true });

    const { onMagicLinkVerified } = renderLogin();
    await reachMagicSent();

    expect(screen.getByText('Sign-in link expired')).toBeInTheDocument();
    expect(screen.getByText(/request a new one/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /request a new link/i })).toBeInTheDocument();
    expect(onMagicLinkVerified).not.toHaveBeenCalled();

    const calls = magicLinkStatusApi.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 3);
    });
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(calls); // stopped
  });

  it('404 from the status endpoint → expired error state, polling stops', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockRejectedValue(new NotFoundError('Unknown login request'));

    const { onMagicLinkVerified } = renderLogin();
    await reachMagicSent();

    expect(screen.getByText('Sign-in link expired')).toBeInTheDocument();
    expect(onMagicLinkVerified).not.toHaveBeenCalled();

    const calls = magicLinkStatusApi.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 3);
    });
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(calls);
  });

  it('leaving the magic-sent view (Use a different email) tears the poll down — no poll after unmount', async () => {
    tagAc(AC);
    magicLinkStatusApi.mockResolvedValue({ verified: false, expired: false });

    renderLogin();
    await reachMagicSent();
    const calls = magicLinkStatusApi.mock.calls.length;

    // Click "Use a different email" → unmounts MagicSentScreen back to enter-email.
    const back = screen.getByRole('button', { name: /use a different email/i });
    await act(async () => {
      fireEvent.click(back);
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(MAGIC_LINK_POLL_INTERVAL_MS * 5);
    });
    await flush();
    expect(magicLinkStatusApi).toHaveBeenCalledTimes(calls); // interval cleared
  });
});

describe('signup.form_viewed — the funnel head (spec-324 ac-10 / ac-12)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    probeAuthApi.mockReset();
    trackAnonymous.mockReset();
  });

  // enter-email → Continue → probe decides which password view shows.
  async function reachPasswordForm(probe: unknown): Promise<void> {
    probeAuthApi.mockResolvedValue(probe);
    renderLogin();
    const input = screen.getByPlaceholderText('you@company.com');
    await act(async () => {
      fireEvent.change(input, { target: { value: EMAIL } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await flush();
  }

  it('fires signup.form_viewed once when the signup (create-password) form is shown', async () => {
    tagAc(`${AC324}/ac-10`);
    tagAc(`${AC324}/ac-12`);
    await reachPasswordForm({ exists: false }); // new user → create-password (signup)

    expect(screen.getByRole('heading', { name: /^sign up$/i })).toBeInTheDocument();
    expect(trackAnonymous).toHaveBeenCalledTimes(1);
    expect(trackAnonymous).toHaveBeenCalledWith('signup.form_viewed', { method: 'password' });
  });

  it('does NOT fire on the sign-in (existing user) form', async () => {
    tagAc(`${AC324}/ac-10`);
    await reachPasswordForm({ exists: true, hasPassword: true }); // existing → sign-in

    expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
    expect(trackAnonymous).not.toHaveBeenCalled();
  });

  it('fires signup.cta_clicked when the signup CTA is submitted (spec-367 ac-9)', async () => {
    tagAc(`${AC367}/ac-9`);
    await reachPasswordForm({ exists: false }); // signup (create-password) view
    trackAnonymous.mockClear(); // drop the form_viewed fire — assert the CTA fire only
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('••••••••••'), {
        target: { value: 'longenoughpw' }, // ≥10 chars so the signup CTA enables
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^sign up$/i }));
    });
    expect(trackAnonymous).toHaveBeenCalledWith('signup.cta_clicked', { method: 'password' });
  });

  it('does NOT fire signup.cta_clicked on the sign-in submit (spec-367 ac-9)', async () => {
    tagAc(`${AC367}/ac-9`);
    await reachPasswordForm({ exists: true, hasPassword: true }); // sign-in view
    trackAnonymous.mockClear();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('••••••••••'), {
        target: { value: 'anypassword' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    });
    expect(trackAnonymous).not.toHaveBeenCalledWith('signup.cta_clicked', expect.anything());
  });
});

// spec-326 dec-1/ac-2 — the signup surface discloses legitimate-interest capture
// (the LOUD supersede of a prior anonymous decline). Shown on signup, absent on signin.
describe('LoginScreen — signup privacy notice [spec-326 ac-2]', () => {
  beforeEach(() => {
    vi.useRealTimers();
    probeAuthApi.mockReset();
    magicLinkRequestApi.mockReset();
  });

  // Drive enter-email → the view the probe selects (create-password = signup,
  // password = signin).
  async function reachView(probe: { exists: boolean; hasPassword?: boolean }): Promise<void> {
    probeAuthApi.mockResolvedValue(probe);
    renderLogin();
    const input = screen.getByPlaceholderText('you@company.com');
    await act(async () => {
      fireEvent.change(input, { target: { value: EMAIL } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    });
    await flush();
  }

  it('the signup view shows the legitimate-interest notice + the right-to-object pointer', async () => {
    tagAc(`${AC326}/ac-2`);
    await reachView({ exists: false }); // unknown email → create-password (signup)
    expect(screen.getByRole('heading', { name: 'Sign up' })).toBeInTheDocument();
    const notice = screen.getByTestId('signup-privacy-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/legitimate-interest/i);
    expect(notice).toHaveTextContent(/object/i);
  });

  it('the signin view does NOT show the signup privacy notice', async () => {
    tagAc(`${AC326}/ac-2`);
    await reachView({ exists: true, hasPassword: true }); // known + password → signin
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByTestId('signup-privacy-notice')).toBeNull();
  });
});
