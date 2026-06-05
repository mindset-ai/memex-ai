import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import {
  oauthAuthorizePreviewApi,
  oauthAuthorizeDecisionApi,
  type OAuthAuthorizePreview,
  type OAuthAuthorizeParams,
} from '../api/client';

// b-31 dec-8: the Org picker UI. The preview endpoint returns the user's
// grantable Orgs; we pre-select the first one when the user has exactly
// one. Submit always carries an `org_id` (or null for personal-only).

type Status =
  | 'loading'
  | 'pending'
  | 'submitting'
  | 'success'
  | 'invalid_request'
  | 'unauthorized'
  | 'error';

// b-31 W1 t-5 — OAuth 2.1 consent screen. The server's GET /api/oauth/authorize
// 302s here with all OAuth params preserved as query string. We fetch the
// client name + scopes via the preview endpoint, render the consent UI, and on
// the user's decision POST to /api/oauth/authorize and `window.location` to the
// redirect URL the server returns.
//
// All security validation (redirect_uri allowlist, PKCE method, client lookup)
// happens server-side. This page just renders + collects consent.
export function OauthAuthorize() {
  const { token, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const params = useMemo<OAuthAuthorizeParams | null>(() => {
    const required = [
      'response_type',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
    ] as const;
    const out: Record<string, string> = {};
    for (const k of required) {
      const v = searchParams.get(k);
      if (!v) return null;
      out[k] = v;
    }
    const scope = searchParams.get('scope');
    const state = searchParams.get('state');
    if (scope) out.scope = scope;
    if (state) out.state = state;
    return out as unknown as OAuthAuthorizeParams;
  }, [searchParams]);

  const [status, setStatus] = useState<Status>('loading');
  const [preview, setPreview] = useState<OAuthAuthorizePreview | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Selected Org id (UUID) for the grant, or null for personal-only.
  // Initialised from preview.orgs in the useEffect below.
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  useEffect(() => {
    if (!params) {
      setStatus('invalid_request');
      setErrorMessage('Missing required OAuth parameters');
      return;
    }
    // If the user isn't logged in, bounce to /login with a return path that
    // preserves every OAuth param so the flow resumes after auth.
    if (!isAuthenticated) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const data = await oauthAuthorizePreviewApi(params, token);
        if (cancelled) return;
        setPreview(data);
        // Pre-select the user's only Org when they have exactly one;
        // otherwise leave null and let the user pick (or fall through
        // to personal-only when orgs is empty).
        if (data.orgs.length === 1) setSelectedOrgId(data.orgs[0].id);
        setStatus('pending');
      } catch (err) {
        if (cancelled) return;
        const e = err as Error & { status?: number };
        if (e.status === 401) {
          setStatus('unauthorized');
        } else {
          setStatus('invalid_request');
        }
        setErrorMessage(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, isAuthenticated, navigate, token]);

  async function submitDecision(decision: 'allow' | 'deny') {
    if (!params) return;
    // When user has >1 Org and hasn't picked, refuse to submit — the server
    // would 400 anyway, but a client-side guard gives a clearer message.
    if (
      decision === 'allow' &&
      preview &&
      preview.orgs.length > 1 &&
      !selectedOrgId
    ) {
      setErrorMessage('Pick an Org before allowing.');
      return;
    }
    setStatus('submitting');
    setErrorMessage(null);
    try {
      const { redirect } = await oauthAuthorizeDecisionApi(
        params,
        decision,
        token,
        selectedOrgId,
      );
      setStatus('success');
      // Bounce the browser. The server has set ?code=&state= (on allow) or
      // ?error=access_denied&state= (on deny) and the redirect_uri is the
      // one the client registered.
      window.location.href = redirect;
    } catch (err) {
      setStatus('pending');
      setErrorMessage(err instanceof Error ? err.message : 'Authorize failed');
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-16">
      <h1 className="text-2xl font-semibold mb-2 text-heading">Connect to Memex</h1>
      <p className="text-sm mb-8 text-secondary">
        An application is asking to access your Memex. Review what's being
        granted before you approve.
      </p>

      <div className="border rounded-lg p-6 bg-surface border-edge">
        {status === 'loading' && (
          <p className="text-sm text-secondary">Loading client details…</p>
        )}

        {status === 'invalid_request' && (
          <div>
            <p className="text-sm text-error mb-2">This OAuth request can't be processed.</p>
            {errorMessage && <p className="text-xs text-muted">{errorMessage}</p>}
          </div>
        )}

        {status === 'unauthorized' && (
          <p className="text-sm text-error">
            You need to be signed in to authorize. Try refreshing this page after
            logging in.
          </p>
        )}

        {status === 'error' && (
          <div>
            <p className="text-sm text-error mb-2">Something went wrong.</p>
            {errorMessage && <p className="text-xs text-muted">{errorMessage}</p>}
          </div>
        )}

        {(status === 'pending' || status === 'submitting') && preview && (
          <>
            <div className="mb-6">
              <div className="text-muted uppercase tracking-wide text-xs mb-1">
                Application
              </div>
              <div className="text-base text-primary font-medium">{preview.client_name}</div>
            </div>

            {/* Org picker (b-31 dec-8) — shown only when the user has >1 Org.
                For 0 or 1 Org we skip the picker and show a fixed sentence. */}
            {preview.orgs.length > 1 && (
              <div className="mb-6">
                <label
                  htmlFor="oauth-org-picker"
                  className="block text-muted uppercase tracking-wide text-xs mb-1"
                >
                  Org
                </label>
                <select
                  id="oauth-org-picker"
                  value={selectedOrgId ?? ''}
                  onChange={(e) => setSelectedOrgId(e.target.value || null)}
                  className="w-full border border-edge rounded-md bg-page text-primary px-3 py-2 text-sm"
                >
                  <option value="" disabled>
                    Choose the Org to grant access to…
                  </option>
                  {preview.orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted mt-2">
                  You can only grant one Org per OAuth flow. To connect another Org,
                  authorise again from the same connector.
                </p>
              </div>
            )}

            <div className="mb-8">
              <div className="text-muted uppercase tracking-wide text-xs mb-1">
                Permissions requested
              </div>
              <ul className="text-sm text-primary list-disc pl-5">
                {preview.scopes.includes('memex.full') && (
                  <li>
                    Full access to{' '}
                    {preview.orgs.length === 0 ? (
                      <>your <strong>personal Memex</strong></>
                    ) : preview.orgs.length === 1 ? (
                      <>
                        your <strong>{preview.orgs[0].name}</strong> Org and your{' '}
                        <strong>personal Memex</strong>
                      </>
                    ) : selectedOrgId ? (
                      <>
                        your{' '}
                        <strong>
                          {preview.orgs.find((o) => o.id === selectedOrgId)?.name}
                        </strong>{' '}
                        Org and your <strong>personal Memex</strong>
                      </>
                    ) : (
                      <>the Org you select above and your personal Memex</>
                    )}
                    {' '}— read &amp; write documents, decisions, tasks, and comments on
                    your behalf.
                  </li>
                )}
              </ul>
            </div>

            {errorMessage && (
              <p className="text-sm text-error mb-4">{errorMessage}</p>
            )}

            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => submitDecision('deny')}
                disabled={status === 'submitting'}
                className="px-4 py-2 border border-edge rounded-md text-sm font-medium hover:bg-surface-hover disabled:opacity-50"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => submitDecision('allow')}
                disabled={status === 'submitting'}
                className="px-4 py-2 bg-accent text-on-accent rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {status === 'submitting' ? 'Authorizing…' : 'Allow'}
              </button>
            </div>
          </>
        )}

        {status === 'success' && (
          <p className="text-sm text-secondary">
            Redirecting you back to the application…
          </p>
        )}
      </div>

      <p className="text-xs text-muted mt-4">
        You can revoke this access any time from your{' '}
        <a href="/settings/tokens" className="underline">
          settings
        </a>
        .
      </p>
    </div>
  );
}
