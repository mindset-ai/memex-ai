import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Alert } from './ui/Alert';
import { useAuth } from './AuthContext';
import {
  fetchMemexApi,
  updateMemexNameApi,
  renameMemexSlugApi,
  checkMemexSlugApi,
  type MemexVisibilityDto,
} from '../api/client';

// spec-479 t-4 — rename controls on the per-Memex settings page, beside the
// visibility editor. Two independent actions (D-2):
//   • Display name saves immediately — no URL impact, no confirm.
//   • URL slug is the address segment; renaming it changes every link, so it
//     goes through a confirm and, on success, navigates to the new
//     /<ns>/<new-slug>/settings URL. Old links keep working via the server's
//     memex_rename redirect (std-10 §7), and the freed slug can't be reused
//     while that redirect is live (D-4) — surfaced by the live availability
//     check as "reserved".
export function RenameMemexSection({
  memexId,
  namespaceSlug,
}: {
  memexId: string;
  namespaceSlug: string;
}) {
  const { token, refreshSession } = useAuth();
  const navigate = useNavigate();
  const [memex, setMemex] = useState<MemexVisibilityDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [slug, setSlug] = useState('');
  const [check, setCheck] = useState<{ available: boolean; reason?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const checkSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchMemexApi(memexId, token);
      setMemex(data);
      setName(data.name);
      setSlug(data.slug);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [memexId, token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live slug availability — 400ms debounce, seq-guarded (mirrors CreateOrgForm),
  // only while the slug differs from the persisted value.
  useEffect(() => {
    if (!memex) return;
    const trimmed = slug.trim().toLowerCase();
    if (!trimmed || trimmed === memex.slug) {
      setCheck(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const seq = ++checkSeq.current;
    const handle = window.setTimeout(async () => {
      try {
        const result = await checkMemexSlugApi(memex.namespaceId, trimmed, token);
        if (checkSeq.current === seq) {
          setCheck(result);
          setChecking(false);
        }
      } catch {
        if (checkSeq.current === seq) {
          setCheck(null);
          setChecking(false);
        }
      }
    }, 400);
    return () => window.clearTimeout(handle);
  }, [slug, memex, token]);

  const onSaveName = useCallback(async () => {
    if (!memex) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === memex.name) return;
    setSavingName(true);
    setError(null);
    setNameSaved(false);
    try {
      const updated = await updateMemexNameApi(memexId, trimmed, token);
      setMemex(updated);
      setName(updated.name);
      setNameSaved(true);
      // Keep the session's membership label (sidebar switcher) in sync.
      await refreshSession();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingName(false);
    }
  }, [memex, name, memexId, token, refreshSession]);

  const onConfirmRename = useCallback(async () => {
    if (!memex) return;
    const trimmed = slug.trim().toLowerCase();
    setRenaming(true);
    setError(null);
    try {
      const updated = await renameMemexSlugApi(memexId, trimmed, token);
      // Refresh the session FIRST: its membership rows still carry the old slug,
      // and TenantLayout gates the new URL on membership — navigating before the
      // refresh bounces the user to their default landing. Only then navigate to
      // the new address (server-validated slug → safe/same-origin path).
      await refreshSession();
      navigate(`/${namespaceSlug}/${updated.slug}/settings`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setRenaming(false);
      setConfirming(false);
    }
  }, [memex, slug, memexId, token, namespaceSlug, navigate, refreshSession]);

  if (!memex) {
    return error ? (
      <div className="text-sm text-status-danger-text">{error}</div>
    ) : (
      <div className="text-sm text-muted">Loading…</div>
    );
  }

  const trimmedSlug = slug.trim().toLowerCase();
  const slugChanged = trimmedSlug !== '' && trimmedSlug !== memex.slug;
  const slugAvailable = check?.available === true;

  return (
    <section className="space-y-6" data-testid="memex-rename">
      <div>
        <h3 className="text-sm font-semibold text-heading">Rename</h3>
        <p className="text-sm text-secondary mt-1">
          Change this Memex's display name or its URL address.
        </p>
      </div>

      {error && (
        <Alert variant="danger" size="md">
          {error}
        </Alert>
      )}

      <div className="space-y-2">
        <label className="block text-sm text-secondary">
          Display name
          <div className="flex gap-2 mt-1">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameSaved(false);
              }}
              data-testid="memex-name-input"
            />
            <Button
              onClick={onSaveName}
              disabled={savingName || !name.trim() || name.trim() === memex.name}
              data-testid="memex-name-save"
            >
              Save
            </Button>
          </div>
        </label>
        {nameSaved && <div className="text-xs text-status-success-text">Name saved.</div>}
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-secondary">
          URL address
          <div className="flex gap-2 mt-1">
            <Input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setConfirming(false);
              }}
              data-testid="memex-slug-input"
            />
            <Button
              variant="secondary"
              onClick={() => setConfirming(true)}
              disabled={!slugChanged || !slugAvailable || checking}
              data-testid="memex-slug-rename"
            >
              Rename URL
            </Button>
          </div>
        </label>
        <p className="text-xs text-muted">
          memex.ai/{namespaceSlug}/
          <span className="text-primary">{trimmedSlug || memex.slug}</span>
        </p>
        {slugChanged && !checking && check && !check.available && (
          <div className="text-xs text-status-danger-text" data-testid="memex-slug-unavailable">
            {check.reason === 'redirected'
              ? 'That address was used before and is reserved by a redirect.'
              : check.reason === 'taken'
                ? 'That address is already taken in this namespace.'
                : "That address isn't valid."}
          </div>
        )}
      </div>

      {confirming && (
        <div
          className="space-y-3 p-3 rounded-lg border border-edge bg-card"
          data-testid="memex-slug-confirm"
        >
          <p className="text-sm text-primary">
            Rename the URL to <code>{trimmedSlug}</code>?
          </p>
          <ul className="text-xs text-secondary list-disc pl-5 space-y-1">
            <li>Old links keep working — they forward to the new address.</li>
            <li>The old address can't be reused while that forward is live.</li>
          </ul>
          <div className="flex gap-2">
            <Button
              onClick={onConfirmRename}
              disabled={renaming}
              data-testid="memex-slug-confirm-btn"
            >
              {renaming ? 'Renaming…' : 'Confirm rename'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={renaming}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
