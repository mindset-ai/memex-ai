import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import {
  getNamespaceHomeApi,
  listMyNamespacesApi,
  type NamespaceHomeResponse,
} from '../api/client';
import { tenantPathFor } from '../utils/tenantUrl';
import { AddMemexDialog } from '../components/AddMemexDialog';
import { CreateOrgDialog } from '../components/CreateOrgDialog';
import { InviteMembersDialog } from '../components/InviteMembersDialog';
import { Button } from '../components/ui';
import { Spinner } from '../components/Spinner';
import { formatDate } from '../utils/format';

interface OrgEntry {
  namespaceId: string;
  namespaceSlug: string;
  home: Extract<NamespaceHomeResponse, { kind: 'org' }>;
}

// Kind-aware home page for a namespace (doc-19 t-10).
//
// - On a personal namespace (`/<user-namespace>`) → personal Memex view.
// - On a team-org namespace (`/<org-namespace>`) → "Manage Orgs": one card per
//   team org the caller is in, with per-org Add Memex + a top-right Add Org.
//   The URL slug picks an entry point but doesn't constrain the content —
//   `/<orgA>` and `/<orgB>` both render the same list when the caller is in
//   both.
export function NamespaceHome() {
  const { namespace: namespaceSlug } = useParams<{ namespace: string }>();
  const { token, refreshSession } = useAuth();
  const [kind, setKind] = useState<'personal' | 'org' | null>(null);
  const [personalHome, setPersonalHome] = useState<
    Extract<NamespaceHomeResponse, { kind: 'personal' }> | null
  >(null);
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addMemexForOrg, setAddMemexForOrg] = useState<OrgEntry | null>(null);
  const [inviteForOrg, setInviteForOrg] = useState<OrgEntry | null>(null);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);

  // Bumping `reloadTick` re-runs the fetch effect; AddMemexDialog onClose calls
  // it so a freshly-created Memex appears without a full page reload.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!namespaceSlug) return;
    setLoading(true);
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        const groups = await listMyNamespacesApi(token);
        const match = groups.find((g) => g.namespaceSlug === namespaceSlug);
        if (!match?.namespaceId) {
          if (!cancelled) {
            setError('Namespace not found');
            setLoading(false);
          }
          return;
        }

        if (match.kind === 'personal') {
          const payload = await getNamespaceHomeApi(match.namespaceId, token);
          if (cancelled) return;
          if (payload.kind !== 'personal') {
            setError('Unexpected namespace kind');
          } else {
            setKind('personal');
            setPersonalHome(payload);
          }
          setLoading(false);
          return;
        }

        // Team org — fetch home for every team-org namespace the caller is in.
        const teamGroups = groups.filter(
          (g) => g.kind === 'team' && g.namespaceId,
        );
        const entries = await Promise.all(
          teamGroups.map(async (g) => {
            const home = await getNamespaceHomeApi(g.namespaceId!, token);
            return { group: g, home };
          }),
        );
        if (cancelled) return;

        const orgEntries: OrgEntry[] = entries
          .filter((e): e is { group: typeof e.group; home: Extract<NamespaceHomeResponse, { kind: 'org' }> } => e.home.kind === 'org')
          .map((e) => ({
            namespaceId: e.group.namespaceId!,
            namespaceSlug: e.group.namespaceSlug,
            home: e.home,
          }));

        setKind('org');
        setOrgs(orgEntries);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [namespaceSlug, token, reloadTick]);

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-8">
        <div className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text">
          Failed to load namespace: {error}
        </div>
      </div>
    );
  }

  if (kind === 'personal' && personalHome && namespaceSlug) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-semibold text-heading mb-2">Your personal Memex</h1>
        <p className="text-secondary mb-6">
          Yours forever. Use it for personal notes, drafts, and your own Specs.
        </p>
        {personalHome.memex ? (
          <Link
            to={tenantPathFor(namespaceSlug, personalHome.memex.slug, '/specs')}
            className="block px-4 py-3 rounded-lg border border-edge bg-card-hover hover:bg-overlay transition-colors"
          >
            <div className="font-medium text-primary">{personalHome.memex.name}</div>
            <div className="text-xs text-muted">{namespaceSlug} / {personalHome.memex.slug}</div>
          </Link>
        ) : (
          <div className="text-muted text-sm">No personal Memex yet.</div>
        )}

        <hr className="my-10 border-edge" />

        <div>
          <h2 className="text-lg font-semibold text-heading mb-2">Working with a team?</h2>
          <p className="text-secondary mb-4">
            An Org lets you collaborate with teammates and add as many Memexes as you need.
          </p>
          <Button onClick={() => setCreateOrgOpen(true)}>Create an Org →</Button>
        </div>

        {createOrgOpen && <CreateOrgDialog onClose={() => setCreateOrgOpen(false)} />}
      </div>
    );
  }

  // org variant — Manage Orgs view.
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-heading">Your Orgs</h1>
          <p className="text-sm text-muted mt-1">
            Each Org groups its Memexes for shared work.
          </p>
        </div>
        <Button onClick={() => setCreateOrgOpen(true)}>+ Add Org</Button>
      </div>

      {orgs.length === 0 ? (
        <div className="rounded-lg border border-edge bg-card-hover px-6 py-10 text-center">
          <p className="text-secondary mb-4">You're not in any Orgs yet.</p>
          <Button onClick={() => setCreateOrgOpen(true)}>+ Add Org</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {orgs.map((entry) => (
            <OrgCard
              key={entry.namespaceId}
              entry={entry}
              selected={entry.namespaceSlug === namespaceSlug}
              onAddMemex={() => setAddMemexForOrg(entry)}
              onInviteMembers={() => setInviteForOrg(entry)}
            />
          ))}
        </div>
      )}

      {addMemexForOrg && (
        <AddMemexDialog
          namespaceId={addMemexForOrg.namespaceId}
          namespaceSlug={addMemexForOrg.namespaceSlug}
          orgName={addMemexForOrg.home.org.name}
          onClose={() => {
            setAddMemexForOrg(null);
            setReloadTick((t) => t + 1);
          }}
          onCreated={async () => {
            // Stay on Manage Orgs — close the dialog and refresh the list so
            // the new Memex appears in its org's card immediately. Await a
            // session refresh BEFORE closing so the TenantLayout membership
            // check sees the new Memex when the user clicks into it; without
            // this, the click can race the SSE-driven refresh and bounce the
            // user to their default landing (personal Memex).
            await refreshSession();
            setAddMemexForOrg(null);
            setReloadTick((t) => t + 1);
          }}
        />
      )}

      {inviteForOrg && inviteForOrg.home.memexes[0] && (
        <InviteMembersDialog
          namespaceSlug={inviteForOrg.namespaceSlug}
          memexSlug={inviteForOrg.home.memexes[0].slug}
          orgName={inviteForOrg.home.org.name}
          onClose={() => setInviteForOrg(null)}
        />
      )}

      {createOrgOpen && <CreateOrgDialog onClose={() => setCreateOrgOpen(false)} />}
    </div>
  );
}

function OrgCard({
  entry,
  selected,
  onAddMemex,
  onInviteMembers,
}: {
  entry: OrgEntry;
  selected: boolean;
  onAddMemex: () => void;
  onInviteMembers: () => void;
}) {
  const { namespaceSlug, home } = entry;
  const empty = home.memexes.length === 0;
  const isAdmin = home.currentRole === 'administrator';
  // Invite endpoint is `/api/<ns>/<mx>/invites` — needs at least one memex of
  // this org to satisfy the route resolver. Hide the button on empty orgs.
  const canInvite = isAdmin && !empty;

  return (
    <section
      className={`rounded-lg border bg-panel transition-colors ${
        selected ? 'border-edge-strong ring-1 ring-edge-strong' : 'border-edge'
      }`}
    >
      {/* Org-level header — visibly the parent: bigger title, room to breathe. */}
      <header className="flex items-start justify-between gap-4 px-5 py-4">
        <Link
          to={`/${namespaceSlug}`}
          className="block min-w-0 flex-1 group"
          aria-label={`Open ${home.org.name}`}
        >
          <span className="block text-xl font-semibold text-heading truncate group-hover:text-link">
            {home.org.name}
          </span>
          <span className="block text-sm text-muted mt-1">
            {home.memberCount} member{home.memberCount === 1 ? '' : 's'}
          </span>
        </Link>
        <div className="flex items-center gap-2 flex-none">
          {canInvite && (
            <Button variant="secondary" onClick={onInviteMembers}>
              Invite members
            </Button>
          )}
          <Button variant="secondary" onClick={onAddMemex}>+ Add Memex</Button>
        </div>
      </header>

      {/* Memexes belong to the org — visually nested under it. */}
      <div className="border-t border-edge bg-surface/30 rounded-b-lg">
        <div className="px-5 pt-3 pb-2 text-xs font-medium uppercase tracking-wider text-muted">
          Memexes{empty ? '' : ` (${home.memexes.length})`}
        </div>
        {empty ? (
          <div className="px-5 pb-4 text-sm text-muted">
            No Memexes yet. Add one to get started — most orgs start with
            <code className="ml-1 text-secondary">main</code>.
          </div>
        ) : (
          <ul className="px-2 pb-2 space-y-0.5">
            {home.memexes.map((m) => (
              <li key={m.id}>
                <Link
                  to={tenantPathFor(namespaceSlug, m.slug, '/specs')}
                  className="flex items-baseline justify-between gap-3 ml-3 px-3 py-2 rounded-md hover:bg-card-hover transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-primary truncate">{m.name}</div>
                    <div className="text-xs text-muted truncate">
                      {namespaceSlug} / {m.slug}
                    </div>
                  </div>
                  <div className="text-xs text-muted whitespace-nowrap">
                    Last activity: {formatDate(m.lastActivityAt)}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
