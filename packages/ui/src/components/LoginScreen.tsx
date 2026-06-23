import { useEffect, useRef, useState, type FormEvent } from 'react';
import { GoogleOAuthProvider, GoogleLogin, type CredentialResponse } from '@react-oauth/google';
import { trackAnonymous } from '../hooks/useTelemetry';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { Logo } from './Logo';
import { probeAuthApi, AuthApiError, type SessionPayload } from '../api/client';
import { useMagicLinkPoll } from '../hooks/useMagicLinkPoll';
// t-23 of doc-15: Google SSO is on a single origin under the path-based
// router. The previous cross-subdomain bounce (sign in on memex.ai then return
// here with a JWT in the URL fragment) is no longer needed — everything is
// same-origin. So GoogleSsoSlot no longer branches.

// Identifier-first auth flow:
//
//   enter-email ──Continue──▶ probe ──┬─▶ password         (existing user with password)
//                                     ├─▶ create-password  (new user)
//                                     └─▶ magic-sent       (existing Google-only user)
//
//   password / create-password ──Email me a link──▶ magic-sent
//   any screen ──Back / Use a different email──▶ enter-email
//
// One quiet primary path (Continue), one parallel SSO option (Google). Magic-link is the
// graceful fallback for users without a password set.

type View =
  | { kind: 'enter-email' }
  | { kind: 'password'; email: string }
  | { kind: 'create-password'; email: string }
  // spec-304 t-40 (ac-30): the magic-sent view carries the `loginRequestId` from
  // the issue response so it can poll login-request status and complete the
  // session IN PLACE when the link is verified in another browser/context.
  | { kind: 'magic-sent'; email: string; loginRequestId: string }
  | { kind: 'reset-sent'; email: string }
  | { kind: 'forgot' };

interface LoginScreenProps {
  authError: string | null;
  googleClientId: string | null;
  onSignup: (email: string, password: string) => Promise<void>;
  onLogin: (email: string, password: string) => Promise<void>;
  /**
   * Issue a magic link. spec-304 t-40 (ac-30): resolves to the surrogate
   * `loginRequestId` the magic-sent view polls so login can complete in place.
   */
  onMagicLink: (email: string) => Promise<{ loginRequestId: string }>;
  /**
   * spec-304 t-40 (ac-30): adopt the session once polling sees it verified —
   * wire to the SAME path password/SSO/`/consume` login uses (`acceptSession`)
   * so the polled login truly completes (token persisted, redirect into the app).
   */
  onMagicLinkVerified: (session: SessionPayload) => void;
  onPasswordReset: (email: string) => Promise<void>;
  onGoogleCredential: (credential: string) => Promise<void>;
}

export function LoginScreen(props: LoginScreenProps) {
  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-heading">
            <Logo className="h-7" />
          </h1>
        </div>
        <LoginCard {...props} />
      </div>
    </div>
  );
}

function LoginCard(props: LoginScreenProps) {
  const [view, setView] = useState<View>({ kind: 'enter-email' });

  switch (view.kind) {
    case 'enter-email':
      return (
        <EnterEmailScreen
          authError={props.authError}
          googleClientId={props.googleClientId}
          onGoogleCredential={(credential) => {
            // Pre-auth → trackAnonymous (no tenant yet); method enum only.
            trackAnonymous('auth.login_started', { method: 'google' });
            return props.onGoogleCredential(credential);
          }}
          onContinue={async (email) => {
            const probe = await probeAuthApi(email);
            if (!probe.exists) setView({ kind: 'create-password', email });
            else if (probe.hasPassword) setView({ kind: 'password', email });
            else {
              trackAnonymous('auth.login_started', { method: 'magic_link' });
              const { loginRequestId } = await props.onMagicLink(email);
              setView({ kind: 'magic-sent', email, loginRequestId });
            }
          }}
        />
      );

    case 'password':
      return (
        <PasswordScreen
          email={view.email}
          mode="signin"
          authError={props.authError}
          onSubmit={(password) => {
            trackAnonymous('auth.login_started', { method: 'password' });
            return props.onLogin(view.email, password);
          }}
          onForgot={() => setView({ kind: 'forgot' })}
          onMagicLink={async () => {
            trackAnonymous('auth.login_started', { method: 'magic_link' });
            const { loginRequestId } = await props.onMagicLink(view.email);
            setView({ kind: 'magic-sent', email: view.email, loginRequestId });
          }}
          onBack={() => setView({ kind: 'enter-email' })}
        />
      );

    case 'create-password':
      return (
        <PasswordScreen
          email={view.email}
          mode="signup"
          authError={props.authError}
          onSubmit={(password) => props.onSignup(view.email, password)}
          onMagicLink={async () => {
            const { loginRequestId } = await props.onMagicLink(view.email);
            setView({ kind: 'magic-sent', email: view.email, loginRequestId });
          }}
          onBack={() => setView({ kind: 'enter-email' })}
        />
      );

    case 'magic-sent':
      return (
        <MagicSentScreen
          email={view.email}
          loginRequestId={view.loginRequestId}
          onMagicLinkVerified={props.onMagicLinkVerified}
          onBack={() => setView({ kind: 'enter-email' })}
        />
      );

    case 'reset-sent':
      return (
        <ConfirmCard
          title="Reset link sent"
          body={`If a Memex exists for ${view.email}, a reset link is on its way.`}
          onBack={() => setView({ kind: 'enter-email' })}
        />
      );

    case 'forgot':
      return (
        <ForgotPasswordForm
          authError={props.authError}
          onSubmit={async (email) => {
            await props.onPasswordReset(email);
            setView({ kind: 'reset-sent', email });
          }}
          onBack={() => setView({ kind: 'enter-email' })}
        />
      );
  }
}

function EnterEmailScreen({
  authError,
  googleClientId,
  onGoogleCredential,
  onContinue,
}: {
  authError: string | null;
  googleClientId: string | null;
  onGoogleCredential: (credential: string) => Promise<void>;
  onContinue: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const e2 = email.trim().toLowerCase();
    if (!e2) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await onContinue(e2);
    } catch (err) {
      setLocalError(
        err instanceof AuthApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Something went wrong'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const error = localError ?? authError;

  return (
    <div className="rounded-xl border border-edge bg-card p-6 space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-xs text-secondary mb-1">Email</span>
          <Input
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-xs text-status-danger-text">
            {error}
          </div>
        )}

        <Button type="submit" disabled={submitting || !email.trim()} className="w-full">
          {submitting ? 'Continuing…' : 'Continue'}
        </Button>
      </form>

      {googleClientId && <GoogleSsoSlot googleClientId={googleClientId} onGoogleCredential={onGoogleCredential} />}
    </div>
  );
}

// Google OAuth 2.0 requires every JavaScript origin to be explicitly registered in the
// OAuth client config; wildcards aren't supported. With path-based routing every tenant
// shares a single origin, so we only need to register `int.memex.ai` + `memex.ai`. No
// cross-subdomain bounce required.
function GoogleSsoSlot({
  googleClientId,
  onGoogleCredential,
}: {
  googleClientId: string;
  onGoogleCredential: (credential: string) => Promise<void>;
}) {
  return (
    <>
      <Divider>or</Divider>
      <GoogleOAuthProvider clientId={googleClientId}>
        <div className="flex justify-center">
          <GoogleLogin
            onSuccess={(response: CredentialResponse) => {
              if (response.credential) onGoogleCredential(response.credential);
            }}
            onError={() => console.error('Google login failed')}
            theme="filled_black"
            size="large"
            text="continue_with"
          />
        </div>
      </GoogleOAuthProvider>
    </>
  );
}

function PasswordScreen({
  email,
  mode,
  authError,
  onSubmit,
  onForgot,
  onMagicLink,
  onBack,
}: {
  email: string;
  mode: 'signin' | 'signup';
  authError: string | null;
  onSubmit: (password: string) => Promise<void>;
  onForgot?: () => void;
  onMagicLink: () => Promise<void>;
  onBack: () => void;
}) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sendingMagic, setSendingMagic] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // spec-324 / spec-367 — the funnel HEAD. Fire signup.form_viewed once when the
  // signup form (create-password) is first shown, pre-auth, via the anonymous
  // ingress. Identifier-less volume under legitimate interest (spec-367): no consent,
  // no visitor_id; the only gate inside trackAnonymous is the opt-out. Deduped so a
  // re-render never re-fires; advisory. Sign-in views never fire it.
  const viewedSent = useRef(false);
  useEffect(() => {
    if (mode === 'signup' && !viewedSent.current) {
      viewedSent.current = true;
      trackAnonymous('signup.form_viewed', { method: 'password' });
    }
  }, [mode]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    // spec-367 — the funnel's second step: the signup CTA was clicked (identifier-less
    // volume via the anonymous ingress). Signup view only; sign-in submits never fire it.
    if (mode === 'signup') {
      trackAnonymous('signup.cta_clicked', { method: 'password' });
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      await onSubmit(password);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMagic = async () => {
    setSendingMagic(true);
    setLocalError(null);
    try {
      await onMagicLink();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Send failed');
      setSendingMagic(false);
    }
  };

  const error = localError ?? authError;
  const minLen = mode === 'signup' ? 10 : 1;
  const canSubmit = !submitting && password.length >= minLen;

  return (
    <div className="rounded-xl border border-edge bg-card p-6 space-y-4">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-muted hover:text-secondary mb-1"
        >
          ← Use a different email
        </button>
        <h2 className="text-base font-semibold text-heading">
          {mode === 'signup' ? 'Sign up' : 'Welcome back'}
        </h2>
        <p className="text-xs text-secondary mt-1">{email}</p>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-xs text-secondary">
              Password {mode === 'signup' && <span className="text-muted">(min 10 chars)</span>}
            </span>
            {mode === 'signin' && onForgot && (
              <button
                type="button"
                onClick={onForgot}
                className="text-xs text-muted hover:text-secondary"
              >
                Forgot?
              </button>
            )}
          </div>
          <Input
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            autoFocus
            minLength={minLen}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
          />
        </label>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-xs text-status-danger-text">
            {error}
          </div>
        )}

        <Button type="submit" disabled={!canSubmit} className="w-full">
          {submitting
            ? mode === 'signup'
              ? 'Signing up…'
              : 'Signing in…'
            : mode === 'signup'
              ? 'Sign up'
              : 'Sign in'}
        </Button>
      </form>

      <div className="text-center">
        <button
          type="button"
          onClick={handleMagic}
          disabled={sendingMagic}
          className="text-xs text-muted hover:text-secondary disabled:opacity-50"
        >
          {sendingMagic ? 'Sending…' : 'Email me a sign-in link instead'}
        </button>
      </div>

      {/* spec-326 dec-1/ac-2: the LOUD supersede. Signing up discloses that product
          usage is captured by default under legitimate interest — visible here, so a
          prior anonymous decline is superseded in the open, never silently flipped.
          Placeholder copy; legal owns the final wording (spec-326 out-of-scope). */}
      {mode === 'signup' && (
        <p className="text-xs text-muted border-t border-edge pt-3" data-testid="signup-privacy-notice">
          Memex records anonymous product-usage events (IDs and counts only — no
          document content, message text, or keystrokes) to improve the product, on a
          legitimate-interest basis. You can object at any time under Settings →
          Product-usage analytics.
        </p>
      )}
    </div>
  );
}

function ForgotPasswordForm({
  authError,
  onSubmit,
  onBack,
}: {
  authError: string | null;
  onSubmit: (email: string) => Promise<void>;
  onBack: () => void;
}) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const e2 = email.trim().toLowerCase();
    if (!e2) return;
    setSubmitting(true);
    try {
      await onSubmit(e2);
    } catch {
      // surfaced via authError
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-edge bg-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-heading">Reset password</h2>
        <button type="button" onClick={onBack} className="text-xs text-muted hover:text-secondary">
          ← Back
        </button>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="block text-xs text-secondary mb-1">Email</span>
          <Input
            type="email"
            autoComplete="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>
        {authError && (
          <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-xs text-status-danger-text">
            {authError}
          </div>
        )}
        <Button type="submit" disabled={submitting || !email.trim()} className="w-full">
          {submitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </div>
  );
}

// spec-304 t-40 (ac-30): the "check your email" view. While shown it polls the
// login-request surrogate so the session completes IN THIS TAB/WEBVIEW the moment
// the link is verified anywhere — the user never has to click back here. The poll
// runs ONLY while this component is mounted (cleanup tears the interval down on
// unmount / "Use a different email"). On verified it adopts the session via the
// passed-down `acceptSession`; on expiry/404 it offers a fresh link.
function MagicSentScreen({
  email,
  loginRequestId,
  onMagicLinkVerified,
  onBack,
}: {
  email: string;
  loginRequestId: string;
  onMagicLinkVerified: (session: SessionPayload) => void;
  onBack: () => void;
}) {
  const phase = useMagicLinkPoll(loginRequestId, onMagicLinkVerified);

  if (phase === 'verified') {
    return (
      <ConfirmCard
        title="Signed in"
        body="You're signed in — taking you to your Memex…"
      />
    );
  }

  if (phase === 'expired') {
    return (
      <ConfirmCard
        title="Sign-in link expired"
        body="Your sign-in link expired — request a new one."
        onBack={onBack}
        backLabel="← Request a new link"
      />
    );
  }

  return (
    <ConfirmCard
      title="Check your email"
      body={`We sent a sign-in link to ${email}. It expires in 15 minutes.`}
      onBack={onBack}
    />
  );
}

function ConfirmCard({
  title,
  body,
  onBack,
  backLabel = '← Use a different email',
}: {
  title: string;
  body: string;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-card p-6 space-y-4 text-center">
      <h2 className="text-base font-semibold text-heading">{title}</h2>
      <p className="text-sm text-secondary">{body}</p>
      {onBack && (
        <button onClick={onBack} className="text-xs text-muted hover:text-secondary">
          {backLabel}
        </button>
      )}
    </div>
  );
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <div className="flex-1 h-px bg-edge" />
      <span>{children}</span>
      <div className="flex-1 h-px bg-edge" />
    </div>
  );
}
