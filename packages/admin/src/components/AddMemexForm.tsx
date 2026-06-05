import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { useAuth } from './AuthContext';
import {
  checkMemexSlugApi,
  createMemexApi,
  OrgApiError,
  type OrgSlugCheckResult,
  type OrgSlugCheckReason,
} from '../api/client';
import { tenantPathFor } from '../utils/tenantUrl';

// Per the "Form components: fork, don't share" convention in doc-19 section #4,
// AddMemexForm mirrors CreateOrgForm's structure but with the Memex-specific
// endpoint, error codes, and post-create navigation. Three near-duplicate lines
// beat a shared <SlugForm> primitive that has to discriminate every behaviour.
const SLUG_REASON_MESSAGES: Record<OrgSlugCheckReason, string> = {
  too_short: 'Slug must be at least 1 character',
  too_long: 'Slug must be at most 39 characters',
  invalid_chars: 'Use only letters, numbers, and hyphens (no leading or trailing hyphen)',
  reserved: 'That slug is reserved — pick another',
  taken: 'That slug is already taken in this Org',
};

const ERROR_CODE_MESSAGES: Record<string, string> = {
  kind_not_org: "You can't add Memexes to a personal namespace",
  not_a_member: "You're not a member of this Org",
  slug_taken: 'Slug already taken — try another',
  validation_error: 'Slug is invalid',
};

export interface AddMemexFormProps {
  namespaceId: string;
  namespaceSlug: string;
  orgName: string;
  onCancel?: () => void;
  // Override the post-create navigation target. Defaults to navigating to
  // `/<namespace>/<slug>/specs` so the user lands inside their new Memex.
  onCreated?: (memexSlug: string) => void;
  // Caller-provided toast hook for the 403 / kind_not_org and 403 / not_a_member
  // cases that close the dialog. Defaults to console.warn.
  onToast?: (message: string) => void;
}

export function AddMemexForm({
  namespaceId,
  namespaceSlug,
  orgName,
  onCancel,
  onCreated,
  onToast,
}: AddMemexFormProps) {
  const { token } = useAuth();
  const [slug, setSlug] = useState('');
  const [check, setCheck] = useState<OrgSlugCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const checkSeq = useRef(0);

  useEffect(() => {
    const trimmed = slug.trim().toLowerCase();
    if (!trimmed) {
      setCheck(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const seq = ++checkSeq.current;
    const handle = window.setTimeout(async () => {
      try {
        const result = await checkMemexSlugApi(namespaceId, trimmed, token);
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
  }, [slug, token, namespaceId]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = slug.trim().toLowerCase();
      if (!trimmed || !check?.available) return;
      setSubmitting(true);
      setSubmitError(null);
      try {
        await createMemexApi(namespaceId, trimmed, undefined, token);
        if (onCreated) {
          onCreated(trimmed);
        } else {
          window.location.href = tenantPathFor(namespaceSlug, trimmed, '/specs');
        }
      } catch (err) {
        setSubmitting(false);
        if (err instanceof OrgApiError) {
          const code = err.errorCode ?? err.code;
          if (err.status === 403 && (code === 'kind_not_org' || code === 'not_a_member')) {
            // Defensive — CTA should be hidden in these cases. Close + toast.
            (onToast ?? console.warn)(
              code === 'kind_not_org'
                ? ERROR_CODE_MESSAGES.kind_not_org
                : ERROR_CODE_MESSAGES.not_a_member,
            );
            onCancel?.();
            return;
          }
          if (err.status === 409) {
            setSubmitError(ERROR_CODE_MESSAGES.slug_taken);
            return;
          }
          if (err.status === 400) {
            setSubmitError(err.message);
            return;
          }
        }
        setSubmitError('Something went wrong. Please try again.');
      }
    },
    [slug, check, token, namespaceId, namespaceSlug, onCreated, onCancel, onToast],
  );

  const trimmed = slug.trim().toLowerCase();
  const previewHost = `${window.location.host}/${namespaceSlug}/${trimmed || '<slug>'}`;
  const canSubmit = !!check?.available && !submitting;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-secondary">
        A Memex is a living document — Specs, decisions, tasks, all in one place.
      </p>
      <label className="block">
        <span className="block text-sm text-secondary mb-1">Slug</span>
        <Input
          autoFocus
          value={slug}
          onChange={(e) => setSlug(e.target.value.replace(/\s+/g, '-').toLowerCase())}
          placeholder="main"
          maxLength={39}
        />
        <div className="mt-1 text-xs text-muted">
          Letters, numbers, hyphens. Lowercase.
        </div>
        <div className="mt-2 text-xs text-muted">
          URL: <code className="text-secondary">https://{previewHost}</code>
        </div>
      </label>

      <SlugStatus slug={trimmed} checking={checking} check={check} />

      {submitError && (
        <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
          {submitError}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? 'Adding…' : 'Add Memex'}
        </Button>
      </div>
      {/* Silence unused-warning when orgName isn't read in this render. */}
      <span aria-hidden="true" className="sr-only">{orgName}</span>
    </form>
  );
}

function SlugStatus({
  slug,
  checking,
  check,
}: {
  slug: string;
  checking: boolean;
  check: OrgSlugCheckResult | null;
}) {
  if (!slug) return null;
  if (checking) {
    return <div className="text-xs text-muted">Checking availability…</div>;
  }
  if (!check) return null;
  if (!check.available) {
    const message = check.reason
      ? SLUG_REASON_MESSAGES[check.reason]
      : 'Invalid slug';
    return (
      <div className="text-xs text-status-danger-text" aria-label="slug unavailable">
        ✗ {message}
      </div>
    );
  }
  return (
    <div className="text-xs text-status-success-text" aria-label="slug available">
      ✓ Available
    </div>
  );
}
