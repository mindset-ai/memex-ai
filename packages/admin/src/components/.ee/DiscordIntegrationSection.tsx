// ENTERPRISE EDITION — Memex Enterprise License (see LICENSE_EE.md).
// The `.ee` dirname is the license marker: this Discord integration UI is
// Enterprise-only (spec-138).

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { useUserChangeStream } from '../../hooks/useUserChangeStream';
import {
  getDiscordWebhookApi,
  saveDiscordWebhookApi,
  deleteDiscordWebhookApi,
  type DiscordWebhookStatus,
} from '../../api/client';

// One webhook row per org the user belongs to — mirrors the Slack section's
// per-org structure. Personal memexes are excluded (Discord is org-scoped).
interface OrgRow {
  namespace: string;
  memex: string;   // primary memex slug for API calls
  label: string;   // display name (namespace slug)
  isAdmin: boolean;
}

interface OrgWebhookState {
  status: DiscordWebhookStatus | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  disconnecting: boolean;
  webhookUrl: string;
  channelName: string;
}

function emptyState(): OrgWebhookState {
  return { status: null, loading: true, error: null, saving: false, disconnecting: false, webhookUrl: '', channelName: '' };
}

export function DiscordIntegrationSection() {
  const { token, session } = useAuth();

  // Derive org memberships — one row per unique namespace (org), using the
  // first memex in that namespace for API calls.
  const orgs: OrgRow[] = (() => {
    if (!session?.memberships) return [];
    const seen = new Set<string>();
    const rows: OrgRow[] = [];
    for (const m of session.memberships) {
      if ((m as { kind?: string }).kind === 'personal') continue;
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);
      rows.push({
        namespace: m.slug,
        memex: (m as { memexSlug?: string }).memexSlug ?? 'main',
        label: m.slug,
        isAdmin: m.role === 'administrator',
      });
    }
    return rows;
  })();

  const [states, setStates] = useState<Record<string, OrgWebhookState>>(() =>
    Object.fromEntries(orgs.map((o) => [o.namespace, emptyState()]))
  );

  const patch = (namespace: string, update: Partial<OrgWebhookState>) =>
    setStates((prev) => ({ ...prev, [namespace]: { ...prev[namespace], ...update } }));

  const loadOrg = useCallback(async (org: OrgRow) => {
    patch(org.namespace, { loading: true, error: null });
    try {
      const s = await getDiscordWebhookApi(token, org.namespace, org.memex);
      patch(org.namespace, { status: s, loading: false });
    } catch (err) {
      patch(org.namespace, { loading: false, error: err instanceof Error ? err.message : 'Failed to load' });
    }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    orgs.forEach((o) => loadOrg(o));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useUserChangeStream(() => orgs.forEach((o) => loadOrg(o)), ['org_discord_webhook']);

  async function handleSave(org: OrgRow, e: React.FormEvent) {
    e.preventDefault();
    const st = states[org.namespace];
    if (!st?.webhookUrl.trim()) return;
    patch(org.namespace, { saving: true, error: null });
    try {
      await saveDiscordWebhookApi(token, org.namespace, org.memex, st.webhookUrl.trim(), st.channelName.trim() || undefined);
      patch(org.namespace, { saving: false, webhookUrl: '', channelName: '' });
      await loadOrg(org);
    } catch (err) {
      patch(org.namespace, { saving: false, error: err instanceof Error ? err.message : 'Failed to save' });
    }
  }

  async function handleDisconnect(org: OrgRow) {
    if (!confirm('Remove Discord webhook for this org?')) return;
    patch(org.namespace, { disconnecting: true, error: null });
    try {
      await deleteDiscordWebhookApi(token, org.namespace, org.memex);
      patch(org.namespace, { disconnecting: false });
      await loadOrg(org);
    } catch (err) {
      patch(org.namespace, { disconnecting: false, error: err instanceof Error ? err.message : 'Failed to disconnect' });
    }
  }

  return (
    <section id="discord" aria-labelledby="discord-heading">
      <div className="border rounded-lg bg-overlay border-edge overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-start gap-4">
          <div className="flex-none mt-0.5">
            <DiscordLogo />
          </div>
          <div>
            <h2 id="discord-heading" className="text-base font-semibold text-heading mb-0.5">Discord</h2>
            <p className="text-sm text-secondary">
              Send messages to a Discord channel from agents and workflows. Paste a webhook URL
              from your Discord server's channel settings — no OAuth required.
            </p>
          </div>
        </div>

        {/* One row per org */}
        <div className="border-t border-edge divide-y divide-edge">
          {orgs.length === 0 && (
            <div className="px-6 py-5">
              <p className="text-sm text-secondary">No org workspaces. Discord webhooks require an org Memex.</p>
            </div>
          )}
          {orgs.map((org) => {
            const st = states[org.namespace] ?? emptyState();
            return (
              <OrgWebhookRow
                key={org.namespace}
                org={org}
                state={st}
                onSave={(e) => handleSave(org, e)}
                onDisconnect={() => handleDisconnect(org)}
                onChange={(field, val) => patch(org.namespace, { [field]: val })}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

interface OrgWebhookRowProps {
  org: OrgRow;
  state: OrgWebhookState;
  onSave: (e: React.FormEvent) => void;
  onDisconnect: () => void;
  onChange: (field: 'webhookUrl' | 'channelName', val: string) => void;
}

function OrgWebhookRow({ org, state, onSave, onDisconnect, onChange }: OrgWebhookRowProps) {
  return (
    <div className="px-6 py-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-secondary mb-3">{org.label}</p>

      {state.error && <p className="text-xs text-error mb-3">{state.error}</p>}

      {state.loading ? (
        <p className="text-sm text-secondary">Loading…</p>
      ) : state.status?.connected ? (
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-none" />
              Connected
            </span>
            {state.status.channelName && (
              <p className="text-xs text-secondary mt-1">{state.status.channelName}</p>
            )}
          </div>
          {org.isAdmin && (
            <button
              onClick={onDisconnect}
              disabled={state.disconnecting}
              className="text-xs px-3 py-1.5 rounded border border-edge text-secondary hover:text-error hover:border-error/50 disabled:opacity-40 transition-colors"
            >
              {state.disconnecting ? 'Removing…' : 'Disconnect'}
            </button>
          )}
        </div>
      ) : org.isAdmin ? (
        <form onSubmit={onSave} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Webhook URL</label>
            <input
              type="url"
              value={state.webhookUrl}
              onChange={(e) => onChange('webhookUrl', e.target.value)}
              placeholder="https://discord.com/api/webhooks/…"
              required
              className="w-full text-sm px-3 py-2 rounded border border-edge bg-input text-primary placeholder:text-secondary focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">
              Channel name <span className="font-normal">(optional label)</span>
            </label>
            <input
              type="text"
              value={state.channelName}
              onChange={(e) => onChange('channelName', e.target.value)}
              placeholder="#announcements"
              className="w-full text-sm px-3 py-2 rounded border border-edge bg-input text-primary placeholder:text-secondary focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>
          <button
            type="submit"
            disabled={state.saving || !state.webhookUrl.trim()}
            className="text-xs px-4 py-2 rounded border border-edge bg-btn-secondary hover:bg-btn-secondary-hover text-primary font-medium disabled:opacity-40 transition-colors"
          >
            {state.saving ? 'Saving…' : 'Save webhook'}
          </button>
        </form>
      ) : (
        <p className="text-xs text-secondary">Not configured. Ask an org admin to add a webhook.</p>
      )}
    </div>
  );
}

function DiscordLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 127.14 96.36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"
        fill="#5865F2"
      />
    </svg>
  );
}
