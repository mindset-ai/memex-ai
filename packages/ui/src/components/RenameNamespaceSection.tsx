import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Alert } from './ui/Alert';
import { useAuth } from './AuthContext';
import {
  checkNamespaceSlugApi,
  renameNamespaceSlugApi,
  type OrgSlugCheckResult,
} from '../api/client';

// spec-481 t-2 — the namespace-slug rename control on /:namespace/settings.
//
// A namespace has no display name (only orgs do — edited elsewhere), so unlike
// RenameMemexSection this is slug-only. The slug is the first URL segment;
// renaming it changes every link under the namespace, so it goes through a
// confirm and, on success, navigates to the new /<new-ns>/ home (ac-4). Old
// links keep working via the server's namespace_rename redirect (std-10 §7),
// and the freed slug can't be reused while that redirect is live (D-2) —
// surfaced live by the availability check as "reserved by a redirect".
export function RenameNamespaceSection({
  namespaceId,
  currentSlug,
}: {
  namespaceId: string;
  currentSlug: string;
}) {
  const { token, refreshSession } = useAuth();
  const navigate = useNavigate();

  const [slug, setSlug] = useState(currentSlug);
  const [check, setCheck] = useState<OrgSlugCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkSeq = useRef(0);

  // Live slug availability — 400ms debounce, seq-guarded (mirrors
  // RenameMemexSection / CreateOrgForm), only while the slug differs from the
  // persisted value. The namespace pool is global, so the check takes no
  // namespaceId.
  useEffect(() => {
    const trimmed = slug.trim().toLowerCase();
    if (!trimmed || trimmed === currentSlug) {
      setCheck(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const seq = ++checkSeq.current;
    const handle = window.setTimeout(async () => {
      try {
        const result = await checkNamespaceSlugApi(trimmed, token);
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
  }, [slug, currentSlug, token]);

  const onConfirmRename = useCallback(async () => {
    const trimmed = slug.trim().toLowerCase();
    setRenaming(true);
    setError(null);
    try {
      const { namespace } = await renameNamespaceSlugApi(namespaceId, trimmed, token);
      // Refresh the session FIRST: its membership rows still carry the old
      // namespace slug, and TenantLayout gates tenant URLs on membership —
      // navigating before the refresh can bounce the user to their default
      // landing (the spec-479 lesson). Only then navigate to the new namespace
      // home (server-validated slug → safe/same-origin path).
      await refreshSession();
      navigate(`/${namespace.slug}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setRenaming(false);
      setConfirming(false);
    }
  }, [slug, namespaceId, token, navigate, refreshSession]);

  const trimmedSlug = slug.trim().toLowerCase();
  const slugChanged = trimmedSlug !== '' && trimmedSlug !== currentSlug;
  const slugAvailable = check?.available === true;

  return (
    <section className="space-y-6" data-testid="namespace-rename">
      <div>
        <h3 className="text-sm font-semibold text-heading">Namespace URL</h3>
        <p className="text-sm text-secondary mt-1">
          Change the address that every Memex in this namespace lives under.
        </p>
      </div>

      {error && (
        <Alert variant="danger" size="md">
          {error}
        </Alert>
      )}

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
              data-testid="namespace-slug-input"
            />
            <Button
              variant="secondary"
              onClick={() => setConfirming(true)}
              disabled={!slugChanged || !slugAvailable || checking}
              data-testid="namespace-slug-rename"
            >
              Rename URL
            </Button>
          </div>
        </label>
        <p className="text-xs text-muted">
          memex.ai/<span className="text-primary">{trimmedSlug || currentSlug}</span>
        </p>
        {slugChanged && !checking && check && !check.available && (
          <div
            className="text-xs text-status-danger-text"
            data-testid="namespace-slug-unavailable"
          >
            {check.reason === 'redirected'
              ? 'That address was used before and is reserved by a redirect.'
              : check.reason === 'taken' || check.reason === 'reserved'
                ? 'That address is already taken.'
                : "That address isn't valid."}
          </div>
        )}
      </div>

      {confirming && (
        <div
          className="space-y-3 p-3 rounded-lg border border-edge bg-card"
          data-testid="namespace-slug-confirm"
        >
          <p className="text-sm text-primary">
            Rename the namespace URL to <code>{trimmedSlug}</code>?
          </p>
          <ul className="text-xs text-secondary list-disc pl-5 space-y-1">
            <li>Every Memex in this namespace moves to the new address.</li>
            <li>Old links keep working — they forward to the new address.</li>
            <li>You can't rename again for 30 days, and the old address stays reserved.</li>
          </ul>
          <div className="flex gap-2">
            <Button
              onClick={onConfirmRename}
              disabled={renaming}
              data-testid="namespace-slug-confirm-btn"
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
