import { useState, type FormEvent } from 'react';
import { GoogleOAuthProvider, GoogleLogin, type CredentialResponse } from '@react-oauth/google';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { Logo } from './Logo';
import { probeAuthApi, AuthApiError } from '../api/client';
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
  | { kind: 'magic-sent'; email: string }
  | { kind: 'reset-sent'; email: string }
  | { kind: 'forgot' };

interface LoginScreenProps {
  authError: string | null;
  googleClientId: string | null;
  onSignup: (email: string, password: string) => Promise<void>;
  onLogin: (email: string, password: string) => Promise<void>;
  onMagicLink: (email: string) => Promise<void>;
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
          onGoogleCredential={props.onGoogleCredential}
          onContinue={async (email) => {
            const probe = await probeAuthApi(email);
            if (!probe.exists) setView({ kind: 'create-password', email });
            else if (probe.hasPassword) setView({ kind: 'password', email });
            else {
              await props.onMagicLink(email);
              setView({ kind: 'magic-sent', email });
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
          onSubmit={(password) => props.onLogin(view.email, password)}
          onForgot={() => setView({ kind: 'forgot' })}
          onMagicLink={async () => {
            await props.onMagicLink(view.email);
            setView({ kind: 'magic-sent', email: view.email });
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
            await props.onMagicLink(view.email);
            setView({ kind: 'magic-sent', email: view.email });
          }}
          onBack={() => setView({ kind: 'enter-email' })}
        />
      );

    case 'magic-sent':
      return (
        <ConfirmCard
          title="Check your email"
          body={`We sent a sign-in link to ${view.email}. It expires in 15 minutes.`}
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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
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

function ConfirmCard({ title, body, onBack }: { title: string; body: string; onBack: () => void }) {
  return (
    <div className="rounded-xl border border-edge bg-card p-6 space-y-4 text-center">
      <h2 className="text-base font-semibold text-heading">{title}</h2>
      <p className="text-sm text-secondary">{body}</p>
      <button onClick={onBack} className="text-xs text-muted hover:text-secondary">
        ← Use a different email
      </button>
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
