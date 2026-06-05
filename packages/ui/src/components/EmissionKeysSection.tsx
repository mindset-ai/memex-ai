// spec-129 t-5 — per-Memex AC-emission key management. Generate → the raw key is
// shown ONCE; list shows only the non-secret prefix; revoke is a soft-revoke (the
// row stays, dimmed).
//
// spec-129 dec-8 (t-12): now mounted on the member-visible "Memex keys" page
// (/<ns>/<mx>/keys), not the admin-only Settings page. The list/revoke API is
// role-scoped server-side — a member sees + revokes only their own keys; an admin
// sees + revokes all — so this component renders identically for both and lets the
// server draw the boundary.
//
// There is deliberately NO anonymous-emission toggle here (dec-3 / dec-7): a
// valid key is required for every emission, with no per-Memex opt-in.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { Alert } from './ui/Alert';
import { Button, Input } from './ui';
import {
  listEmissionKeysApi,
  generateEmissionKeyApi,
  revokeEmissionKeyApi,
  type EmissionKeySummary,
  type GeneratedEmissionKey,
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

export function EmissionKeysSection() {
  const { token } = useAuth();
  const [keys, setKeys] = useState<EmissionKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedEmissionKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await listEmissionKeysApi(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load emission keys');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const created = await generateEmissionKeyApi(trimmed, token);
      setGenerated(created); // shown ONCE below
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate key');
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!generated) return;
    try {
      await navigator.clipboard?.writeText(generated.key);
      setCopied(true);
    } catch {
      // Clipboard can fail (permissions / insecure context) — the key is still
      // visible for manual copy, so just leave the button label unchanged.
    }
  }

  async function handleRevoke(id: string) {
    if (
      !confirm(
        'Revoke this emission key? Any CI using it will stop authenticating (emissions will be silently rejected) until you roll out a new key.',
      )
    )
      return;
    setRevoking(id);
    setError(null);
    try {
      await revokeEmissionKeyApi(id, token);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setRevoking(null);
    }
  }

  const active = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);

  return (
    <section id="emission-keys" aria-labelledby="emission-keys-heading" className="space-y-4">
      <div>
        <h2 id="emission-keys-heading" className="text-xl font-semibold mb-2 text-heading">
          Emission Keys
        </h2>
        <p className="text-sm text-secondary">
          Keys that authorize test-result emissions to this Memex's{' '}
          <code className="font-mono text-xs">/api/test-events</code> (AC verification).
          Set one as <code className="font-mono text-xs">MEMEX_EMIT_KEY</code> in your test
          environment / CI secrets — the emission helper attaches it as a{' '}
          <code className="font-mono text-xs">Bearer</code> token on every POST. A key works
          only for this Memex, and you can keep several live at once and revoke them
          independently (rotate without breaking CI).
        </p>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      {generated && (
        <Alert variant="success" size="md">
          <p className="font-medium mb-1">Copy your new key now — it won't be shown again.</p>
          <p className="text-sm mb-3">
            Only a hash is stored. If you lose it, revoke it and generate a new one.
          </p>
          <div className="flex items-center gap-2">
            <code
              data-testid="emission-key-reveal"
              className="flex-1 font-mono text-xs break-all px-3 py-2 rounded bg-overlay border border-edge"
            >
              {generated.key}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleCopy}
              className="shrink-0"
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setGenerated(null)}
              className="shrink-0"
            >
              Done
            </Button>
          </div>
        </Alert>
      )}

      <form onSubmit={handleGenerate} className="flex items-center gap-2">
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. pythonia CI)"
          aria-label="New emission key name"
          className="flex-1"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={generating || name.trim().length === 0}
          className="shrink-0"
        >
          {generating ? 'Generating…' : 'Generate key'}
        </Button>
      </form>

      {loading && <p className="text-sm text-secondary">Loading…</p>}

      {!loading && active.length === 0 && (
        <div className="border rounded-lg p-6 text-sm bg-surface border-edge text-secondary">
          No emission keys yet. Generate one above, then set it as{' '}
          <code className="font-mono text-xs">MEMEX_EMIT_KEY</code> where your tests run.
        </div>
      )}

      {active.length > 0 && (
        <div>
          <h3 className="text-sm font-medium uppercase tracking-wide mb-3 text-muted">
            Active ({active.length})
          </h3>
          <div className="border rounded-lg overflow-hidden bg-overlay border-edge">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge">
                  <th className="text-left px-4 py-2.5 font-medium text-secondary">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium text-secondary">Key</th>
                  <th className="text-left px-4 py-2.5 font-medium text-secondary">Last used</th>
                  <th className="text-left px-4 py-2.5 font-medium text-secondary">Created</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {active.map((k) => (
                  <tr key={k.id} className="border-b last:border-0 border-edge-subtle">
                    <td className="px-4 py-2.5 text-primary">{k.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{k.prefix}…</td>
                    <td className="px-4 py-2.5 text-secondary" title={formatAbsolute(k.lastUsedAt)}>
                      {formatRelative(k.lastUsedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-secondary" title={formatAbsolute(k.createdAt)}>
                      {formatRelative(k.createdAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleRevoke(k.id)}
                        disabled={revoking === k.id}
                      >
                        {revoking === k.id ? 'Revoking…' : 'Revoke'}
                      </Button>
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
                {revoked.map((k) => (
                  <tr key={k.id} className="border-b last:border-0 border-edge-subtle">
                    <td className="px-4 py-2.5 text-primary">{k.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{k.prefix}…</td>
                    <td className="px-4 py-2.5 text-xs text-secondary">
                      revoked {formatRelative(k.revokedAt)}
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
