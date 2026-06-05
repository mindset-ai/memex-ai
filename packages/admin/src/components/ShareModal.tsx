import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui/Button';
import { useAuth } from './AuthContext';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import {
  createShareLinkApi,
  listShareLinksApi,
  revokeShareLinkApi,
  type ShareTokenDto,
} from '../api/client';
import { buildBareDomainUrl, getCurrentTenant } from '../utils/tenantUrl';

// Share-link management modal for a document (t-10). Accessible from the doc detail view.
// Lists active share links, lets the user create new ones (copyable URL), and revoke
// existing ones. Revoked links show "This link has been revoked" to guests.
export function ShareModal({
  docId,
  onClose,
}: {
  docId: string;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const [shares, setShares] = useState<ShareTokenDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Share links are flat caller-scoped URLs (`/share/:token`) — no tenant
  // prefix. We still gate on having a tenant context so the modal can only
  // be opened from inside a tenant.
  const tenant = getCurrentTenant();
  const subdomain = tenant?.namespace ?? null;

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await listShareLinksApi(docId, token);
      setShares(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [docId, token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // doc-16 Phase 2: subscribe to the per-doc SSE stream so share_token
  // mutations from another tab / device / MCP land here in real time. The
  // per-doc stream also fires for unrelated entity events (section, comment,
  // task, decision) on the same doc — the refresh is cheap (single REST list
  // call), so we don't filter further.
  useDocChangeStream(docId, refresh);

  const onCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      await createShareLinkApi(docId, token);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [docId, token, refresh]);

  const onRevoke = useCallback(
    async (shareId: string) => {
      try {
        await revokeShareLinkApi(shareId, token);
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [token, refresh]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-w-xl w-full rounded-xl bg-card border border-edge p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-heading">Share this document</h3>
            <p className="text-sm text-secondary mt-1">
              Anyone with a share link can view this document without signing in.
            </p>
          </div>
          <Button onClick={onCreate} disabled={creating}>
            {creating ? 'Creating…' : 'New share link'}
          </Button>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
            {error}
          </div>
        )}

        {loading && <div className="text-sm text-muted">Loading…</div>}

        {!loading && shares && shares.length === 0 && (
          <div className="text-sm text-muted">
            No active share links. Click "New share link" to create one.
          </div>
        )}

        {!loading && shares && shares.length > 0 && subdomain && (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {shares.map((share) => (
              <ShareRow
                key={share.id}
                share={share}
                subdomain={subdomain}
                onRevoke={onRevoke}
              />
            ))}
          </div>
        )}

        <div className="flex justify-end pt-2 border-t border-edge">
          <Button onClick={onClose} variant="secondary">
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShareRow({
  share,
  onRevoke,
}: {
  share: ShareTokenDto;
  subdomain: string;
  onRevoke: (id: string) => void;
}) {
  // t-23 of doc-15: /share/:token is a flat caller-scoped route — no tenant
  // prefix in the URL. The `subdomain` prop is kept on the type for back-compat
  // with the call site that still passes it (a future cleanup can drop it).
  const url = buildBareDomainUrl(`/share/${share.token}`);
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy share URL:', url);
    }
  }, [url]);

  return (
    <div className="flex items-center gap-2 p-3 rounded-lg border border-edge bg-page">
      <code className="flex-1 text-xs text-secondary truncate" title={url}>
        {url}
      </code>
      <Button onClick={onCopy} variant="secondary" size="sm">
        {copied ? 'Copied!' : 'Copy'}
      </Button>
      <Button onClick={() => onRevoke(share.id)} variant="ghost" size="sm">
        Revoke
      </Button>
    </div>
  );
}
