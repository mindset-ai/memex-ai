import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { useAuth } from '../AuthContext';
import {
  createInviteApi,
  listInvitesApi,
  revokeInviteApi,
  type Invite,
} from '../../api/client';
import { buildBareDomainUrl, getCurrentTenant } from '../../utils/tenantUrl';

// Invites tab inside Org Configuration (t-8). Equivalent to the standalone /invites
// page from t-5 but rendered as a tab body (no page chrome).
export function InvitesTab() {
  const { token } = useAuth();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Page lives at /org (flat caller-scoped route). Surface the in-tenant
  // namespace label only when we're under /:namespace/:memex/... (today the
  // tab is on the flat /org route, so this is typically null).
  const tenant = getCurrentTenant();
  const subdomain = tenant?.namespace ?? null;

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await listInvitesApi(token);
      setInvites(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      await createInviteApi(token);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [token, refresh]);

  const onRevoke = useCallback(
    async (id: string) => {
      try {
        await revokeInviteApi(id, token);
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [token, refresh]
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-heading">Invite links</h2>
          <p className="text-sm text-secondary mt-1">
            Single-use invite links. Each expires after 7 days.
          </p>
        </div>
        <Button onClick={onCreate} disabled={creating}>
          {creating ? 'Creating…' : 'New invite link'}
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
          {error}
        </div>
      )}

      {loading && <div className="text-sm text-muted">Loading…</div>}

      {!loading && invites && invites.length === 0 && (
        <div className="text-sm text-muted">No active invites.</div>
      )}

      {!loading && invites && invites.length > 0 && (
        <div className="space-y-2">
          {invites.map((invite) => (
            <InviteRow
              key={invite.id}
              invite={invite}
              subdomain={subdomain ?? ''}
              onRevoke={onRevoke}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function InviteRow({
  invite,
  subdomain,
  onRevoke,
}: {
  invite: Invite;
  subdomain: string;
  onRevoke: (id: string) => void;
}) {
  // t-23 of doc-15: /invite/:token is flat caller-scoped. `subdomain` is kept
  // for back-compat with callers; unused here.
  void subdomain;
  const url = buildBareDomainUrl(`/invite/${invite.token}`);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy invite URL:', url);
    }
  }, [url]);

  const ms = new Date(invite.expiresAt).getTime() - Date.now();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const expiresIn =
    ms <= 0 ? 'expired' : days >= 1 ? `expires in ${days}d` : `expires in ${Math.floor(ms / (60 * 60 * 1000))}h`;

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-edge bg-card">
      <code className="flex-1 text-xs text-secondary truncate" title={url}>
        {url}
      </code>
      <span className="text-xs text-muted whitespace-nowrap">{expiresIn}</span>
      <Button onClick={onCopy} variant="secondary" size="sm">
        {copied ? 'Copied!' : 'Copy'}
      </Button>
      <Button onClick={() => onRevoke(invite.id)} variant="ghost" size="sm">
        Revoke
      </Button>
    </div>
  );
}
