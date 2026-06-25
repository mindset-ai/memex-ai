import { useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { useAuth, computeDefaultLanding } from '../components/AuthContext';
import { Logo } from '../components/Logo';
import { joinOrgApi, OrgApiError } from '../api/client';

type Status = 'idle' | 'joining' | 'success' | 'error';

const ERROR_MESSAGES: Record<string, string> = {
  unknown: "That invite link doesn't look right. Double-check it and try again.",
  expired: 'This invite link has expired. Ask the inviter for a new one.',
  revoked: 'This invite link has been revoked. Ask the inviter for a new one.',
};

// Landing page for /invite/:token — a flat caller-scoped route (see App.tsx).
// Flow:
//   - Not authenticated → AuthContext is already showing the login screen above us, so we
//     render a hint and stash the token until they sign in.
//   - Authenticated → POST /api/invites/accept with the token, redirect to "/" on success.
export function InviteAccept() {
  const { token: tokenParam } = useParams<{ token: string }>();
  const { isAuthenticated, token: bearerToken, session, updateSession } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // t-23 of doc-15: /invite/:token is a flat caller-scoped route. The
  // post-accept destination is computed from the user's memberships after the
  // accept-call refreshes their session: we navigate to the org they just
  // joined.

  const onAccept = useCallback(async () => {
    if (!tokenParam) return;
    setStatus('joining');
    setErrorMessage(null);
    try {
      const fresh = await joinOrgApi(bearerToken, tokenParam);
      updateSession(fresh);
      setStatus('success');
      // The joined tenant is the one matching fresh.currentMemexId. Fall back
      // to computeDefaultLanding(fresh) if the server doesn't surface it.
      const joined =
        fresh.memberships.find((m) => m.memexId === fresh.currentMemexId) ??
        fresh.memberships[fresh.memberships.length - 1];
      const landingPath = joined
        ? `/${joined.slug}/${joined.memexSlug ?? (joined.kind === 'personal' ? 'personal' : 'main')}/specs`
        : (computeDefaultLanding(fresh) ?? '/login');
      // Short pause so the user sees confirmation, then redirect.
      window.setTimeout(() => {
        navigate(landingPath, { replace: true });
      }, 600);
    } catch (err) {
      setStatus('error');
      if (err instanceof OrgApiError && err.reason && ERROR_MESSAGES[err.reason]) {
        setErrorMessage(ERROR_MESSAGES[err.reason]);
      } else if (err instanceof OrgApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Something went wrong. Please try again.');
      }
    }
  }, [tokenParam, bearerToken, navigate, updateSession]);

  if (!tokenParam) {
    return (
      <Centered>
        <Heading>Invalid invite link</Heading>
        <Body>This URL is missing the invite token.</Body>
      </Centered>
    );
  }

  if (!isAuthenticated) {
    return (
      <Centered>
        <Heading>You're invited to join this Memex</Heading>
        <Body>
          Sign in to accept your invite. The sign-in screen will appear shortly.
        </Body>
      </Centered>
    );
  }

  if (status === 'success') {
    return (
      <Centered>
        <Heading>You're in!</Heading>
        <Body>Taking you to your Memex…</Body>
      </Centered>
    );
  }

  if (status === 'error') {
    return (
      <Centered>
        <Heading>Couldn't accept the invite</Heading>
        <Body>{errorMessage}</Body>
        <Button onClick={onAccept} variant="secondary">Try again</Button>
      </Centered>
    );
  }

  return (
    <Centered>
      <Heading>Accept your invite</Heading>
      <Body>You're signed in as {session?.user.email ?? 'an authenticated user'}.</Body>
      <Button onClick={onAccept} disabled={status === 'joining'}>
        {status === 'joining' ? 'Joining…' : 'Accept invite'}
      </Button>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-2xl font-semibold text-heading mb-4 flex justify-center">
          <Logo className="h-7" />
        </h1>
        {children}
      </div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-heading">{children}</h2>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-secondary">{children}</p>;
}
