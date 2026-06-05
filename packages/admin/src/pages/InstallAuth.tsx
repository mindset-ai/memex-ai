import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import {
  lookupCliAuthApi,
  completeCliAuthApi,
  type CliAuthLookupResult,
} from '../api/client';

type Status = 'loading' | 'pending' | 'authorizing' | 'success' | 'expired' | 'not_found' | 'error';

// Renders the device-flow confirm page. The CLI sent the user here with ?code=ABCD-1234;
// we look it up to confirm it's real and unexpired, then offer an Authorize button. On
// click we mint a token; the CLI is long-polling on the server side and picks it up.
export function InstallAuth() {
  const { token } = useAuth();
  const [params] = useSearchParams();
  const code = (params.get('code') ?? '').trim().toUpperCase();
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setLookup] = useState<CliAuthLookupResult | null>(null);

  // Default device label to a reasonable hint; user can edit before authorizing.
  const [label, setLabel] = useState(() => defaultLabel());

  useEffect(() => {
    if (!code) {
      setStatus('not_found');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await lookupCliAuthApi(code, token);
        if (cancelled) return;
        if (!result) {
          setStatus('not_found');
          return;
        }
        setLookup(result);
        if (result.status === 'pending') setStatus('pending');
        else if (result.status === 'completed') setStatus('success');
        else setStatus('expired');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorMessage(err instanceof Error ? err.message : 'Lookup failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, token]);

  async function authorize() {
    setStatus('authorizing');
    setErrorMessage(null);
    try {
      await completeCliAuthApi(code, label.trim() || defaultLabel(), token);
      setStatus('success');
    } catch (err) {
      setStatus('pending');
      setErrorMessage(err instanceof Error ? err.message : 'Authorize failed');
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-16">
      <h1 className="text-2xl font-semibold mb-2 text-heading">Authorize device</h1>
      <p className="text-sm mb-8 text-secondary">
        The Memex installer is waiting for you to confirm this device. The token you grant
        is tied to your user identity and works across all your Memexes.
      </p>

      <div className="border rounded-lg p-6 bg-surface border-edge">
        <div className="mb-4 text-sm">
          <div className="text-muted uppercase tracking-wide text-xs mb-1">Code</div>
          <div className="font-mono text-base text-primary">{code || '—'}</div>
        </div>

        {status === 'loading' && <p className="text-sm text-secondary">Looking up code…</p>}

        {status === 'not_found' && (
          <p className="text-sm text-error">
            We couldn't find that code. It may have expired (5-minute window) or been
            consumed already. Re-run the installer to get a fresh code.
          </p>
        )}

        {status === 'expired' && (
          <p className="text-sm text-error">
            This code has expired or already been used. Re-run the installer to get a
            fresh one.
          </p>
        )}

        {(status === 'pending' || status === 'authorizing') && (
          <>
            <label className="block text-sm font-medium mb-1 text-heading" htmlFor="label">
              Device label
            </label>
            <input
              id="label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={status === 'authorizing'}
              className="w-full mb-4 px-3 py-2 border rounded text-sm bg-input border-edge text-primary"
            />
            <button
              onClick={authorize}
              disabled={status === 'authorizing'}
              className="w-full py-2 rounded font-medium bg-btn-primary hover:bg-btn-primary-hover text-on-primary disabled:opacity-50"
            >
              {status === 'authorizing' ? 'Authorizing…' : 'Authorize installer'}
            </button>
            {errorMessage && (
              <p className="text-xs mt-3 text-error">{errorMessage}</p>
            )}
          </>
        )}

        {status === 'success' && (
          <div className="text-sm">
            <p className="mb-2 text-success">✓ Authorized.</p>
            <p className="text-secondary">
              Return to your terminal — the installer is finishing up. You can close this
              tab.
            </p>
          </div>
        )}

        {status === 'error' && (
          <p className="text-sm text-error">{errorMessage ?? 'Something went wrong.'}</p>
        )}
      </div>
    </div>
  );
}

function defaultLabel(): string {
  // The browser doesn't know the machine's hostname (the installer will pass one via the
  // device label later if we extend the protocol). For now, use a friendly default the
  // user can edit.
  if (typeof navigator === 'undefined') return 'Memex CLI';
  const ua = navigator.userAgent;
  if (ua.includes('Mac')) return 'Mac';
  if (ua.includes('Windows')) return 'Windows PC';
  if (ua.includes('Linux')) return 'Linux';
  return 'Memex CLI';
}
