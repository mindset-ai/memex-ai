import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { useAuth } from '../AuthContext';
import {
  listOrgMembersApi,
  patchOrgMemberApi,
  createInviteApi,
  MemberApiError,
  type OrgMemberDto,
  type Invite,
} from '../../api/client';
import { buildBareDomainUrl } from '../../utils/tenantUrl';

const ERROR_MESSAGES: Record<string, string> = {
  last_admin: 'You can\'t do this — at least one administrator must remain. Promote another user first.',
  cannot_remove_self: 'You can\'t remove yourself.',
  not_found: 'That user is no longer a member.',
  invalid_role: 'Invalid role.',
  invalid_status: 'Invalid status.',
};

export function UsersTab({ onSwitchTab }: { onSwitchTab: (id: string) => void }) {
  const { token, session } = useAuth();
  const [members, setMembers] = useState<OrgMemberDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [inviteModal, setInviteModal] = useState<{ url: string } | null>(null);
  const [creatingInvite, setCreatingInvite] = useState(false);

  const selfUserId = session?.user.id;

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await listOrgMembersApi(token);
      setMembers(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handlePatch = useCallback(
    async (userId: string, patch: Parameters<typeof patchOrgMemberApi>[2]) => {
      setBusyUserId(userId);
      setError(null);
      try {
        await patchOrgMemberApi(token, userId, patch);
        await refresh();
      } catch (err) {
        if (err instanceof MemberApiError && err.code) {
          setError(ERROR_MESSAGES[err.code] ?? err.message);
        } else {
          setError((err as Error).message);
        }
      } finally {
        setBusyUserId(null);
      }
    },
    [token, refresh]
  );

  const onCreateInvite = useCallback(async () => {
    setCreatingInvite(true);
    setError(null);
    try {
      const invite: Invite = await createInviteApi(token);
      // t-23 of doc-15: /invite/:token is flat caller-scoped.
      const url = buildBareDomainUrl(`/invite/${invite.token}`);
      setInviteModal({ url });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingInvite(false);
    }
  }, [token]);

  // Counts: how many active admins (used to disable demote/remove buttons client-side)
  const activeAdminCount = (members ?? []).filter(
    (m) => m.role === 'administrator' && m.status === 'active'
  ).length;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-heading">Members</h2>
          <p className="text-sm text-secondary mt-1">
            People with access to this Org. Disabled members keep their attribution but
            cannot sign in.
          </p>
        </div>
        <Button onClick={onCreateInvite} disabled={creatingInvite}>
          {creatingInvite ? 'Creating…' : 'Invite new user'}
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
          {error}
        </div>
      )}

      {loading && <div className="text-sm text-muted">Loading…</div>}

      {!loading && members && members.length === 0 && (
        <div className="text-sm text-muted">No members yet.</div>
      )}

      {!loading && members && members.length > 0 && (
        <div className="space-y-2">
          {members.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              isSelf={m.userId === selfUserId}
              activeAdminCount={activeAdminCount}
              busy={busyUserId === m.userId}
              onPatch={(patch) => handlePatch(m.userId, patch)}
            />
          ))}
        </div>
      )}

      {inviteModal && (
        <InviteModal
          url={inviteModal.url}
          onClose={() => setInviteModal(null)}
          onSeeAll={() => {
            setInviteModal(null);
            onSwitchTab('invites');
          }}
        />
      )}
    </section>
  );
}

function MemberRow({
  member,
  isSelf,
  activeAdminCount,
  busy,
  onPatch,
}: {
  member: OrgMemberDto;
  isSelf: boolean;
  activeAdminCount: number;
  busy: boolean;
  onPatch: (patch: { role?: 'member' | 'administrator'; status?: 'active' | 'disabled' }) => void;
}) {
  const isDisabled = member.status === 'disabled';
  const isAdmin = member.role === 'administrator';
  const isLastActiveAdmin = isAdmin && member.status === 'active' && activeAdminCount <= 1;

  // Server is the source of truth; client mirrors for UX so the button is visibly disabled
  // (with a tooltip) before clicking.
  const disableRemove = isSelf || isLastActiveAdmin || busy || isDisabled;
  const removeTitle = isSelf
    ? "You can't remove yourself"
    : isLastActiveAdmin
      ? 'At least one administrator must remain'
      : '';

  const disableDemote = isLastActiveAdmin || busy;
  const demoteTitle = isLastActiveAdmin ? 'At least one administrator must remain' : '';

  const labelEmail = isDisabled ? `${member.email} (Inactive)` : member.email;

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg border border-edge bg-card"
      data-testid="member-row"
      data-email={member.email}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-primary truncate">{labelEmail}</span>
          {isSelf && (
            <span className="text-[11px] text-muted">(you)</span>
          )}
        </div>
        <div className="text-xs text-muted mt-0.5">
          Joined {new Date(member.joinedAt).toLocaleDateString()}
        </div>
      </div>
      <span
        className={`text-xs px-2 py-0.5 rounded ${
          isAdmin
            ? 'bg-status-success-bg text-status-success-text'
            : 'bg-btn-secondary text-secondary'
        }`}
      >
        {member.role}
      </span>
      <span
        className={`text-xs px-2 py-0.5 rounded ${
          isDisabled
            ? 'bg-status-danger-bg text-status-danger-text'
            : 'bg-btn-secondary text-secondary'
        }`}
      >
        {member.status}
      </span>

      {/* Actions */}
      {isDisabled ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPatch({ status: 'active' })}
          disabled={busy}
        >
          Re-enable
        </Button>
      ) : isAdmin ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onPatch({ role: 'member' })}
          disabled={disableDemote}
          title={demoteTitle}
        >
          Demote
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPatch({ role: 'administrator' })}
          disabled={busy}
        >
          Promote
        </Button>
      )}

      {!isDisabled && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onPatch({ status: 'disabled' })}
          disabled={disableRemove}
          title={removeTitle}
        >
          Remove
        </Button>
      )}
    </div>
  );
}

function InviteModal({
  url,
  onClose,
  onSeeAll,
}: {
  url: string;
  onClose: () => void;
  onSeeAll: () => void;
}) {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-w-lg w-full rounded-xl bg-card border border-edge p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-heading">Invite link created</h3>
          <p className="text-sm text-secondary mt-1">
            Share this link. It expires after 7 days and works once.
          </p>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-lg border border-edge bg-page">
          <code className="flex-1 text-xs text-secondary truncate" title={url}>
            {url}
          </code>
          <Button onClick={onCopy} variant="secondary" size="sm">
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>
        <div className="flex justify-between items-center pt-2">
          <button onClick={onSeeAll} className="text-xs text-muted hover:text-secondary">
            See all invites →
          </button>
          <Button onClick={onClose} variant="secondary">
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
