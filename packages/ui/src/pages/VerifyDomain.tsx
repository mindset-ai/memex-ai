import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/Logo';
import { consumeDomainVerificationApi, OrgApiError } from '../api/client';

type Status = 'idle' | 'verifying' | 'success' | 'error';

const ERROR_MESSAGES: Record<string, string> = {
  unknown: "That verification link doesn't look right. Double-check the URL.",
  expired: 'This verification link has expired. Ask the admin to send a new one.',
  used: 'This verification link has already been used.',
};

// Public landing for /verify-domain/:token. Mirrors the InviteAccept pattern: the token
// itself is the proof, so no auth is required to confirm. Two-step flow (GET-render then
// click-to-POST) so email scanners that prefetch the link don't accidentally consume it.
export function VerifyDomain() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>('idle');
  const [verified, setVerified] = useState<{ domain: string; method: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = useCallback(async () => {
    if (!token) return;
    setStatus('verifying');
    setError(null);
    try {
      const result = await consumeDomainVerificationApi(token);
      setVerified({ domain: result.domain, method: result.method });
      setStatus('success');
    } catch (err) {
      setStatus('error');
      if (err instanceof OrgApiError && err.reason && ERROR_MESSAGES[err.reason]) {
        setError(ERROR_MESSAGES[err.reason]);
      } else {
        setError((err as Error).message);
      }
    }
  }, [token]);

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-2xl font-semibold text-heading mb-4 flex justify-center">
          <Logo className="h-7" />
        </h1>
        {!token && (
          <p className="text-sm text-secondary">This URL is missing the verification token.</p>
        )}
        {token && status === 'idle' && (
          <>
            <h2 className="text-lg font-semibold text-heading">Confirm domain verification</h2>
            <p className="text-sm text-secondary">
              Click below to confirm that you authorize this Memex to manage this email
              domain.
            </p>
            <Button onClick={onConfirm}>Confirm</Button>
          </>
        )}
        {status === 'verifying' && <p className="text-sm text-muted">Verifying…</p>}
        {status === 'success' && verified && (
          <>
            <h2 className="text-lg font-semibold text-heading">Verified</h2>
            <p className="text-sm text-secondary">
              <code className="text-primary">{verified.domain}</code> is now verified for this
              Memex ({verified.method}).
            </p>
          </>
        )}
        {status === 'error' && error && (
          <>
            <h2 className="text-lg font-semibold text-heading">Could not verify</h2>
            <p className="text-sm text-status-danger-text">{error}</p>
          </>
        )}
      </div>
    </div>
  );
}
