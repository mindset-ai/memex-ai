import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from './AuthContext';
import { Button } from './ui/Button';
import {
  createInviteApi,
  listInvitesApi,
  revokeInviteApi,
  type Invite,
} from '../api/client';
import { buildBareDomainUrl } from '../utils/tenantUrl';

// Per-org member-invite dialog launched from the Manage Orgs page. Mirrors the
// InvitesTab content (create / list / copy / revoke) but explicitly targets
// the org via a `{namespaceSlug, memexSlug}` override on the invite API calls,
// so admins can manage invites for an org without first switching their
// session into it.
//
// Any memex of the target org satisfies the route (`/api/<ns>/<mx>/invites`)
// — invites are stored at the org level, so the memex segment is just a
// resolver hint.
export interface InviteMembersDialogProps {
  namespaceSlug: string;
  memexSlug: string;
  orgName: string;
  onClose: () => void;
}

export function InviteMembersDialog({
  namespaceSlug,
  memexSlug,
  orgName,
  onClose,
}: InviteMembersDialogProps) {
  const { token } = useAuth();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const tenantOverride = { namespaceSlug, memexSlug };

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await listInvitesApi(token, tenantOverride);
      setInvites(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, namespaceSlug, memexSlug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ESC closes — modal convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      await createInviteApi(token, tenantOverride);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, namespaceSlug, memexSlug, refresh]);

  const onRevoke = useCallback(
    async (id: string) => {
      try {
        await revokeInviteApi(id, token, tenantOverride);
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, namespaceSlug, memexSlug, refresh],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
          <h2 className="text-base font-semibold text-heading">
            Invite members to {orgName}
          </h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-primary transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-secondary">
              Single-use invite links. Each expires after 7 days.
            </p>
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
                <InviteRow key={invite.id} invite={invite} onRevoke={onRevoke} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function InviteRow({
  invite,
  onRevoke,
}: {
  invite: Invite;
  onRevoke: (id: string) => void;
}) {
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
    ms <= 0
      ? 'expired'
      : days >= 1
      ? `expires in ${days}d`
      : `expires in ${Math.floor(ms / (60 * 60 * 1000))}h`;

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
