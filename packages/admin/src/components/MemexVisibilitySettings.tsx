import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { MemexPublicBadge } from './MemexPublicBadge';
import { MemexVisibilityConfirmDialog } from './MemexVisibilityConfirmDialog';
import {
  fetchMemexApi,
  updateMemexVisibilityApi,
  type MemexVisibility,
  type MemexVisibilityDto,
} from '../api/client';

// spec-111 t-7: the greenfield per-Memex settings surface. There is no
// per-memex settings page today (only org-level OrgConfiguration), so this is
// the first one. It edits visibility only — `memexes` has no description column
// (spec-111 s-3), so we deliberately do not surface a description field.
//
// Flow: radio (Private / Public) → on a real change, open the §2 confirmation
// dialog → on confirm, PATCH /api/.../memexes/:id { visibility } and reflect the
// returned row. The selected radio mirrors the persisted value until confirmed,
// so a Cancel leaves the control on the current visibility.

export const VISIBILITY_EXPOSURE_WARNING =
  'Making a Memex public exposes all specs, decisions, comments, and tasks.';

export function MemexVisibilitySettings({ memexId }: { memexId: string }) {
  const { token } = useAuth();
  const [memex, setMemex] = useState<MemexVisibilityDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<MemexVisibility | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchMemexApi(memexId, token);
      setMemex(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [memexId, token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A radio click only opens the confirm gate — it never mutates directly.
  // Selecting the already-current value is a no-op.
  const onSelect = useCallback(
    (next: MemexVisibility) => {
      if (!memex || next === memex.visibility) return;
      setPending(next);
    },
    [memex],
  );

  const onConfirm = useCallback(async () => {
    if (!pending) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateMemexVisibilityApi(memexId, pending, token);
      setMemex(updated);
      setPending(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [pending, memexId, token]);

  const onCancel = useCallback(() => {
    if (saving) return;
    setPending(null);
  }, [saving]);

  if (loading || !memex) {
    return error ? (
      <div className="text-sm text-status-danger-text">{error}</div>
    ) : (
      <div className="text-sm text-muted">Loading…</div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-heading">{memex.name}</h2>
        <MemexPublicBadge visibility={memex.visibility} />
      </div>

      <div>
        <h3 className="text-sm font-semibold text-heading">Visibility</h3>
        <p className="text-sm text-secondary mt-1">
          Control who can read this Memex. Org members always retain full edit access.
        </p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <label className="flex items-start gap-3 p-3 rounded-lg border border-edge bg-card cursor-pointer">
          <input
            type="radio"
            name="memex-visibility"
            value="private"
            checked={memex.visibility === 'private'}
            onChange={() => onSelect('private')}
            className="mt-0.5 h-4 w-4"
          />
          <span className="text-sm">
            <span className="font-medium text-primary">Private</span>
            <span className="block text-secondary">Only org members can view</span>
          </span>
        </label>

        <label className="flex items-start gap-3 p-3 rounded-lg border border-edge bg-card cursor-pointer">
          <input
            type="radio"
            name="memex-visibility"
            value="public"
            checked={memex.visibility === 'public'}
            onChange={() => onSelect('public')}
            className="mt-0.5 h-4 w-4"
          />
          <span className="text-sm">
            <span className="font-medium text-primary">Public</span>
            <span className="block text-secondary">
              Anyone with the link can view (read-only)
            </span>
          </span>
        </label>
      </div>

      <div className="flex items-start gap-2 text-xs text-status-warning-text">
        <span aria-hidden="true">⚠️</span>
        <span>{VISIBILITY_EXPOSURE_WARNING}</span>
      </div>

      {pending && (
        <MemexVisibilityConfirmDialog
          target={pending}
          busy={saving}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </section>
  );
}
