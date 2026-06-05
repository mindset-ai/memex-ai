// ENTERPRISE EDITION — Memex Enterprise License (see LICENSE_EE.md).
// The `.ee` dirname is the license marker: this Slack integration UI is
// Enterprise-only. spec-141 dec-3 extracted it out of the standalone
// `pages/.ee/SettingsIntegrations.tsx` page into this section component so the
// consolidated Integrations page (open core) can compose it without moving any
// EE code across the license line.

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useUserChangeStream } from '../../hooks/useUserChangeStream';
import { BASE_URL } from '../../api/http';
import { getSlackStatusApi, disconnectSlackApi, type OrgSlackStatus } from '../../api/client';

export function SlackIntegrationSection() {
  const { token } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [statuses, setStatuses] = useState<OrgSlackStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnectingKey, setDisconnectingKey] = useState<string | null>(null);

  const slackParam = searchParams.get('slack');
  const slackReason = searchParams.get('reason');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getSlackStatusApi(token);
      setStatuses(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Slack status');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (slackParam) setSearchParams({}, { replace: true });
  }, [slackParam, setSearchParams]);

  useUserChangeStream(load, ['user_slack_token']);

  async function handleDisconnect(orgId: string | null) {
    if (!confirm('Disconnect Slack? You can reconnect at any time.')) return;
    const key = orgId ?? 'personal';
    setDisconnectingKey(key);
    try {
      await disconnectSlackApi(token, orgId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed');
    } finally {
      setDisconnectingKey(null);
    }
  }

  function connectUrl(orgId: string | null): string {
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (orgId) params.set('org_id', orgId);
    return `${BASE_URL}/auth/slack/start?${params.toString()}`;
  }

  const orgStatuses = statuses.filter((s) => !s.personal);
  const personalStatus = statuses.find((s) => s.personal) ?? null;

  return (
    <section id="slack" aria-labelledby="slack-heading">
      {slackParam === 'connected' && (
        <div className="mb-6 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
          Slack connected successfully.
        </div>
      )}
      {slackParam === 'error' && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Slack connection failed{slackReason ? `: ${slackReason}` : ''}. Please try again.
        </div>
      )}
      {error && (
        <p className="text-sm text-error mb-6">{error}</p>
      )}

      <div className="border rounded-lg bg-overlay border-edge overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 flex items-start gap-4">
          <div className="flex-none mt-0.5">
            <SlackLogo />
          </div>
          <div>
            <h2 id="slack-heading" className="text-base font-semibold text-heading mb-0.5">Slack</h2>
            <p className="text-sm text-secondary">
              Send messages as you from agents and the Memex chat panel. Messages are
              attributed to you in Slack — not a bot.
            </p>
          </div>
        </div>

        {/* Connections */}
        <div className="border-t border-edge px-6 py-5 space-y-6">
          {loading ? (
            <p className="text-sm text-secondary">Loading…</p>
          ) : (
            <>
              {/* Personal */}
              {personalStatus && (
                <div>
                  <SectionLabel>Personal</SectionLabel>
                  <ConnectionRow
                    label="Personal workspace"
                    status={personalStatus}
                    disconnecting={disconnectingKey === 'personal'}
                    connectUrl={connectUrl(null)}
                    onDisconnect={() => handleDisconnect(null)}
                  />
                </div>
              )}

              {/* Organizations */}
              {orgStatuses.length > 0 && (
                <div>
                  <SectionLabel>Organizations</SectionLabel>
                  <div className="space-y-2">
                    {orgStatuses.map((s) => (
                      <ConnectionRow
                        key={s.orgId}
                        label={s.orgName}
                        status={s}
                        disconnecting={disconnectingKey === s.orgId}
                        connectUrl={connectUrl(s.orgId)}
                        onDisconnect={() => handleDisconnect(s.orgId)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {orgStatuses.length === 0 && !personalStatus && (
                <p className="text-sm text-secondary">
                  No Slack connections available. Join an org or connect your personal workspace above.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-secondary whitespace-nowrap">
        {children}
      </span>
      <div className="flex-1 h-px bg-edge" />
    </div>
  );
}

interface ConnectionRowProps {
  label: string;
  status: OrgSlackStatus;
  disconnecting: boolean;
  connectUrl: string;
  onDisconnect: () => void;
}

function ConnectionRow({ label, status, disconnecting, connectUrl, onDisconnect }: ConnectionRowProps) {
  return (
    <div className="rounded-lg border border-edge px-4 py-3 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-heading">{label}</p>
        {status.connected ? (
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-none" />
              Connected
            </span>
            {(status.displayName || status.workspaceName) && (
              <span className="text-xs text-secondary truncate">
                {[status.displayName, status.workspaceName].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
        ) : (
          <p className="text-xs text-secondary mt-0.5">Not connected</p>
        )}
      </div>

      <div className="flex-none">
        {status.connected ? (
          <button
            onClick={onDisconnect}
            disabled={disconnecting}
            className="text-xs px-3 py-1.5 rounded border border-edge text-secondary hover:text-error hover:border-error/50 disabled:opacity-40 transition-colors"
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : (
          <a
            href={connectUrl}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-edge bg-btn-secondary hover:bg-btn-secondary-hover text-primary font-medium transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 54 54" fill="none" aria-hidden="true">
              <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" fill="#36C5F0"/>
              <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" fill="#2EB67D"/>
              <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" fill="#ECB22E"/>
              <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.249m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.249a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387" fill="#E01E5A"/>
            </svg>
            Connect
          </a>
        )}
      </div>
    </div>
  );
}

function SlackLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" fill="#36C5F0"/>
      <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" fill="#2EB67D"/>
      <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" fill="#ECB22E"/>
      <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.249m14.336 0v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.249a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387" fill="#E01E5A"/>
    </svg>
  );
}
