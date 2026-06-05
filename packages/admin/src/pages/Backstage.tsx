import { useEffect, useState } from 'react';

// Platform-admin Memex picker. Opt-in dev-mode tool — the backend returns 403 when
// GOOGLE_CLIENT_ID is set, so hitting this page in prod shows an empty/error state.
// When prod access is needed, add a real auth check on the backend and update this UI
// to surface the disabled state.
interface BackstageMemex {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  domainVerified: boolean;
  autoGroupingEnabled: boolean;
  memberCount: number;
  docCount: number;
}

// Build the namespace-home URL for `slug` — path-based per std-2.
// Lands on NamespaceHome.tsx, where the user picks a Memex.
function namespaceHomeUrl(slug: string): string {
  return `${window.location.origin}/${slug}/`;
}

export function Backstage() {
  const [accounts, setAccounts] = useState<BackstageMemex[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [hopping, setHopping] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/backstage/accounts')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then(setAccounts)
      .catch((e: Error) => setError(e.message));
  }, []);

  // Hop-in flow: POST /impersonate first so the dev user is an admin of the target, THEN
  // navigate to the namespace. Without the impersonate step the resolver sees no
  // membership and kicks us back to the original Memex.
  async function hopIn(memexId: string, slug: string) {
    setHopping(memexId);
    setError(null);
    try {
      const res = await fetch(`/api/backstage/accounts/${memexId}/impersonate`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      window.location.href = namespaceHomeUrl(slug);
    } catch (e) {
      setError((e as Error).message);
      setHopping(null);
    }
  }

  const filtered = (accounts ?? []).filter((a) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    return a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q);
  });

  return (
    <div className="min-h-screen bg-page p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-baseline justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-heading">Backstage</h1>
            <p className="text-sm text-secondary mt-1">
              Every Memex on this instance. Click a row to hop in.
            </p>
          </div>
          <span className="text-xs text-muted">
            {accounts ? `${accounts.length} total` : ''}
          </span>
        </div>

        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or namespace"
          className="w-full mb-4 px-3 py-2 rounded-lg border border-edge bg-card text-sm text-primary placeholder:text-muted focus:outline-none focus:border-edge-strong"
        />

        {error && (
          <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
            {error}
          </div>
        )}

        {!accounts && !error && (
          <div className="text-sm text-muted">Loading…</div>
        )}

        {accounts && filtered.length === 0 && (
          <div className="text-sm text-muted">
            {accounts.length === 0
              ? 'No Memexes yet.'
              : 'No Memexes match that filter.'}
          </div>
        )}

        {filtered.length > 0 && (
          <div className="rounded-xl border border-edge bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-xs text-muted text-left">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Namespace</th>
                  <th className="px-4 py-2 font-medium text-right">Members</th>
                  <th className="px-4 py-2 font-medium text-right">Docs</th>
                  <th className="px-4 py-2 font-medium">Flags</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-edge last:border-0 hover:bg-card-hover transition-colors"
                  >
                    <td className="px-4 py-2 text-primary">{a.name}</td>
                    <td className="px-4 py-2">
                      <code className="text-xs text-secondary">{a.slug}</code>
                    </td>
                    <td className="px-4 py-2 text-right text-secondary">{a.memberCount}</td>
                    <td className="px-4 py-2 text-right text-secondary">{a.docCount}</td>
                    <td className="px-4 py-2 text-xs text-muted space-x-1">
                      {a.domainVerified && (
                        <span className="px-1.5 py-0.5 rounded bg-status-success-bg text-status-success-text">
                          verified
                        </span>
                      )}
                      {a.autoGroupingEnabled && (
                        <span className="px-1.5 py-0.5 rounded bg-btn-secondary text-secondary">
                          auto-group
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {new Date(a.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => hopIn(a.id, a.slug)}
                        disabled={hopping !== null}
                        className="text-xs px-2 py-1 rounded bg-btn-primary text-btn-primary-text hover:opacity-90 disabled:opacity-40"
                      >
                        {hopping === a.id ? 'Hopping…' : 'Hop in →'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
