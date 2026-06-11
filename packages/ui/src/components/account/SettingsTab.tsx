import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useAuth } from '../AuthContext';
import {
  getOrgApi,
  updateOrgApi,
  initiateDomainVerificationApi,
  type OrgSummaryDto,
} from '../../api/client';
import { TelemetryOptOut } from '../TelemetryOptOut';

// Settings tab inside Org Configuration (t-8 / t-11 of doc-15). Replaces the standalone
// /account page from t-6 — same content, no outer page chrome.
export function SettingsTab() {
  const { token } = useAuth();
  const [org, setOrg] = useState<OrgSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await getOrgApi(token);
      setOrg(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading || !org) {
    return error ? (
      <div className="text-sm text-status-danger-text">{error}</div>
    ) : (
      <div className="text-sm text-muted">Loading…</div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm text-secondary">
          {org.name} · {org.slug}
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
          {error}
        </div>
      )}

      <DomainsSection org={org} token={token} onRefresh={refresh} setError={setError} />
      <AutoGroupingSection org={org} token={token} onRefresh={refresh} setError={setError} />
      <TelemetryOptOut />
    </div>
  );
}

function DomainsSection({
  org,
  token,
  onRefresh,
  setError,
}: {
  org: OrgSummaryDto;
  token: string | null;
  onRefresh: () => Promise<void>;
  setError: (m: string | null) => void;
}) {
  const [newDomain, setNewDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);

  const onAdd = useCallback(async () => {
    const trimmed = newDomain.trim().toLowerCase();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await updateOrgApi(token, {
        emailDomains: [...org.emailDomains, trimmed],
      });
      setNewDomain('');
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [newDomain, org.emailDomains, token, onRefresh, setError]);

  const onRemove = useCallback(
    async (domain: string) => {
      setBusy(true);
      setError(null);
      try {
        await updateOrgApi(token, {
          emailDomains: org.emailDomains.filter((d) => d !== domain),
        });
        await onRefresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [org.emailDomains, token, onRefresh, setError]
  );

  const onVerify = useCallback(
    async (domain: string) => {
      setBusy(true);
      setError(null);
      setVerifyResult(null);
      try {
        const result = await initiateDomainVerificationApi(token, domain);
        const note =
          result.sendErrors && result.sendErrors.length > 0
            ? `Verification token created. Some sends failed: ${result.sendErrors.join('; ')}. Check server logs for the link in dev mode.`
            : `Verification email sent to ${result.sentTo.join(' and ')}. The recipient must click the link to confirm. (Dev mode: check server logs for the URL.)`;
        setVerifyResult(note);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [token, setError]
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-heading">Email domains</h2>
        <p className="text-sm text-secondary mt-1">
          Domains your Org uses for email. Verify a domain to enable auto-grouping for users
          signing up with matching emails.
        </p>
      </div>

      {verifyResult && (
        <div className="px-3 py-2 rounded-lg bg-status-success-bg border border-status-success-border text-sm text-status-success-text">
          {verifyResult}
        </div>
      )}

      <div className="space-y-2">
        {org.emailDomains.length === 0 && (
          <div className="text-sm text-muted">No domains yet. Add one below.</div>
        )}
        {org.emailDomains.map((domain) => {
          const verified = org.verifiedDomains.find((v) => v.domain === domain);
          const isFree = org.freeDomainsInUse.includes(domain);
          return (
            <div
              key={domain}
              className="flex items-center gap-3 p-3 rounded-lg border border-edge bg-card"
            >
              <code className="flex-1 text-sm text-primary">{domain}</code>
              {isFree && (
                <span className="text-xs text-status-warning-text" title="Free email provider — auto-grouping disabled (dec-7)">
                  free provider
                </span>
              )}
              {verified ? (
                <span className="text-xs text-status-success-text">verified ({verified.method})</span>
              ) : !isFree ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onVerify(domain)}
                  disabled={busy}
                >
                  Verify via email
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemove(domain)}
                disabled={busy}
              >
                Remove
              </Button>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <Input
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          placeholder="acme.com"
        />
        <Button onClick={onAdd} disabled={busy || !newDomain.trim()}>
          Add domain
        </Button>
      </div>
    </section>
  );
}

function AutoGroupingSection({
  org,
  token,
  onRefresh,
  setError,
}: {
  org: OrgSummaryDto;
  token: string | null;
  onRefresh: () => Promise<void>;
  setError: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const blockedByFreeDomain = org.freeDomainsInUse.length > 0;
  const noVerifiedDomain = org.verifiedDomains.length === 0;

  const onToggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await updateOrgApi(token, { autoGroupingEnabled: !org.autoGroupingEnabled });
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [org.autoGroupingEnabled, token, onRefresh, setError]);

  const disabled = blockedByFreeDomain || busy;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-heading">Auto-grouping</h2>
        <p className="text-sm text-secondary mt-1">
          When enabled, new users signing in with a matching verified email domain are added
          to this Org automatically.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={org.autoGroupingEnabled}
            onChange={onToggle}
            disabled={disabled}
            className="h-4 w-4"
          />
          <span className={`text-sm ${disabled ? 'text-muted' : 'text-primary'}`}>
            {org.autoGroupingEnabled ? 'Auto-grouping enabled' : 'Enable auto-grouping'}
          </span>
        </label>
      </div>
      {blockedByFreeDomain && (
        <div className="text-xs text-status-warning-text">
          Disabled because this Org claims free email providers (
          {org.freeDomainsInUse.join(', ')}). Remove them to enable auto-grouping (dec-7).
        </div>
      )}
      {!blockedByFreeDomain && noVerifiedDomain && (
        <div className="text-xs text-muted">
          You can enable auto-grouping now, but new users will only join automatically once at
          least one domain is verified.
        </div>
      )}
    </section>
  );
}
