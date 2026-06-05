import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { useAuth } from './AuthContext';
import {
  checkNamespaceSlugApi,
  createOrgApi,
  OrgApiError,
  type OrgSlugCheckResult,
  type OrgSlugCheckReason,
} from '../api/client';
import { namespaceHomePath } from '../utils/tenantUrl';

// Per t-14 of doc-15 this form posts to the new POST /api/orgs surface (createOrgApi),
// which creates the Org + Namespace + default Memex in one shot and returns the
// triple. Slug validation runs through GET /api/orgs/check (checkNamespaceSlugApi) with a
// 400ms debounce per the spec.
const SLUG_REASON_MESSAGES: Record<OrgSlugCheckReason, string> = {
  too_short: 'Namespace must be at least 3 characters',
  too_long: 'Namespace must be at most 63 characters',
  invalid_chars: 'Use only letters, numbers, and hyphens (no leading or trailing hyphen)',
  reserved: 'That namespace is reserved — pick another',
  taken: 'That namespace is already taken',
};

// Server-side error codes we render targeted copy for. Anything else falls through
// to a generic "try again" message.
const ERROR_CODE_MESSAGES: Record<string, string> = {
  email_not_verified: 'Verify your email before creating an Org',
  slug_taken: 'Slug already taken — try another',
  rate_limit_exceeded:
    "You've created 5 Orgs in the past 24 hours. Try again later.",
};

export interface CreateOrgFormProps {
  onCancel?: () => void;
  // Override the post-create navigation target; defaults to navigating to the
  // new namespace's subdomain (with auth handoff in the URL fragment).
  onCreated?: (namespaceSlug: string, token: string | null) => void;
}

// Shared form used by the in-app "Create Org" dialog. Requires email
// verification — caller is expected to gate rendering on
// `session.user.emailVerified`. The server returns 403 / `email_not_verified`
// otherwise, which we render with a link to the verification page.
export function CreateOrgForm({ onCancel, onCreated }: CreateOrgFormProps) {
  const { token } = useAuth();
  const [slug, setSlug] = useState('');
  const [check, setCheck] = useState<OrgSlugCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Submit error broken into a message + an optional anchor target so we can
  // render a link to /verify-email for the 403 case without conditionalising
  // every line of the form below.
  const [submitError, setSubmitError] = useState<{
    message: string;
    showVerifyLink?: boolean;
  } | null>(null);
  const checkSeq = useRef(0);

  // Live availability check — 400ms debounce per the t-14 spec. Each request
  // carries a sequence number so a slow earlier response can't overwrite a
  // newer keystroke's result.
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
  }, [slug, token]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = slug.trim().toLowerCase();
      if (!trimmed || !check?.available) return;
      setSubmitting(true);
      setSubmitError(null);
      try {
        await createOrgApi(trimmed, token);
        // Per dec-2 of doc-19, post-create the user lands on the new Org's
        // home page (`/<namespace>/`). The Org has zero Memexes at this point;
        // the page renders the empty-state with the `+ Add Memex` CTA.
        if (onCreated) {
          onCreated(trimmed, token);
        } else {
          window.location.href = namespaceHomePath(trimmed);
        }
      } catch (err) {
        setSubmitting(false);
        if (err instanceof OrgApiError) {
          // Prefer the server's machine code (`code` / `errorCode`) for
          // routing the message; fall back to status mapping for older error
          // shapes.
          const code = err.errorCode ?? err.code;
          if (code && code in ERROR_CODE_MESSAGES) {
            setSubmitError({
              message: ERROR_CODE_MESSAGES[code],
              showVerifyLink: code === 'email_not_verified',
            });
            return;
          }
          // Status-only fallbacks for servers that didn't return a code.
          if (err.status === 403) {
            setSubmitError({
              message: ERROR_CODE_MESSAGES.email_not_verified,
              showVerifyLink: true,
            });
            return;
          }
          if (err.status === 409) {
            setSubmitError({ message: ERROR_CODE_MESSAGES.slug_taken });
            return;
          }
          if (err.status === 429) {
            setSubmitError({ message: ERROR_CODE_MESSAGES.rate_limit_exceeded });
            return;
          }
          if (err.status === 400) {
            setSubmitError({ message: err.message });
            return;
          }
        }
        setSubmitError({ message: 'Something went wrong. Please try again.' });
      }
    },
    [slug, check, token, onCreated],
  );

  const trimmed = slug.trim().toLowerCase();
  // doc-19 dec-1: Org creation makes zero Memexes. The URL preview ends at
  // the Org's home page — Memex paths get appended later when the user adds one.
  const previewHost = `${window.location.host}/${trimmed || '<your-org>'}`;
  const canSubmit = !!check?.available && !submitting;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-secondary">
        An Org is a shared container for your team's Memexes. You'll add your first
        Memex right after creating it.
      </p>
      <label className="block">
        <span className="block text-sm text-secondary mb-1">Slug</span>
        <Input
          autoFocus
          value={slug}
          onChange={(e) => setSlug(e.target.value.replace(/\s+/g, '-').toLowerCase())}
          placeholder="acme"
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
          <div>{submitError.message}</div>
          {submitError.showVerifyLink && (
            <a
              href="/verify-email"
              className="mt-1 inline-block underline text-status-danger-text"
            >
              Go to email verification →
            </a>
          )}
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
          {submitting ? 'Creating…' : 'Create Org'}
        </Button>
      </div>
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
      : 'Invalid namespace';
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
