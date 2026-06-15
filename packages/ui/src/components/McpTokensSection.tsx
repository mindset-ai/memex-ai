// spec-141 dec-3: MCP-token management, extracted from the standalone
// `pages/SettingsTokens.tsx` into a section so the consolidated Integrations
// page can compose it. Open core. Behaviour (realtime refresh, revoke) is
// unchanged; only the outer page wrapper became a <section> and
// the cross-links to the installer now point at the in-page CLI section.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { useUserChangeStream } from '../hooks/useUserChangeStream';
import {
  listMcpTokensApi,
  revokeMcpTokenApi,
  type McpTokenSummary,
} from '../api/client';

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function McpTokensSection() {
  const { token } = useAuth();
  const [tokens, setTokens] = useState<McpTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listMcpTokensApi(token);
      setTokens(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tokens');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  // Real-time: mint/revoke from another tab or device refetches in place.
  useUserChangeStream(load, ['mcp_token']);

  async function handleRevoke(id: string) {
    if (!confirm('Revoke this token? Any installer using it will stop working until you re-install.')) return;
    setRevoking(id);
    try {
      await revokeMcpTokenApi(id, token);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setRevoking(null);
    }
  }

  const active = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);

  return (
    <section id="mcp-tokens" aria-labelledby="mcp-tokens-heading">
      <h2 id="mcp-tokens-heading" className="text-xl font-semibold mb-2 text-heading">MCP Tokens</h2>
      <p className="text-sm mb-6 text-secondary">
        Long-lived tokens that authorize the Memex installer / MCP clients on a device.
        Each token grants access to all your Memexes. Revoke any token to immediately
        cut off the device using it.{' '}
        <a href="#install-cli" className="underline hover:text-primary">
          Install on a new device →
        </a>
      </p>

      {loading && <p className="text-sm text-secondary">Loading…</p>}
      {error && <p className="text-sm text-error mb-4">{error}</p>}

      {!loading && active.length === 0 && (
        <div className="border rounded-lg p-6 text-sm bg-surface border-edge text-secondary">
          You haven't authorized any devices yet.{' '}
          <a href="#install-cli" className="underline hover:text-primary">
            Install the MCP installer
          </a>{' '}
          to get started.
        </div>
      )}

      {active.length > 0 && (
        <div className="mb-10">
          <h3 className="text-sm font-medium uppercase tracking-wide mb-3 text-muted">
            Active ({active.length})
          </h3>
          <div className="border rounded-lg overflow-hidden bg-overlay border-edge">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge">
                  <th className="text-left px-4 py-2.5 font-medium text-secondary">Label</th>
                  <th className="text-left px-4 py-2.5 font-medium text-secondary">Token</th>
                  <th className="text-left px-4 py-2.5 font-medium text-secondary">Last used</th>
                  <th className="text-left px-4 py-2.5 font-medium text-secondary">Created</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {active.map((t) => (
                  <tr key={t.id} className="border-b last:border-0 border-edge-subtle">
                    <td className="px-4 py-2.5 text-primary">{t.label}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{t.prefix}…</td>
                    <td
                      className="px-4 py-2.5 text-secondary"
                      title={formatAbsolute(t.lastUsedAt)}
                    >
                      {formatRelative(t.lastUsedAt)}
                    </td>
                    <td
                      className="px-4 py-2.5 text-secondary"
                      title={formatAbsolute(t.createdAt)}
                    >
                      {formatRelative(t.createdAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => handleRevoke(t.id)}
                        disabled={revoking === t.id}
                        className="text-xs px-3 py-1 rounded text-error hover:bg-error/10 disabled:opacity-50"
                      >
                        {revoking === t.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {revoked.length > 0 && (
        <div>
          <h3 className="text-sm font-medium uppercase tracking-wide mb-3 text-muted">
            Revoked ({revoked.length})
          </h3>
          <div className="border rounded-lg overflow-hidden bg-overlay border-edge opacity-60">
            <table className="w-full text-sm">
              <tbody>
                {revoked.map((t) => (
                  <tr key={t.id} className="border-b last:border-0 border-edge-subtle">
                    <td className="px-4 py-2.5 text-primary">{t.label}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{t.prefix}…</td>
                    <td className="px-4 py-2.5 text-xs text-secondary">
                      revoked {formatRelative(t.revokedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
