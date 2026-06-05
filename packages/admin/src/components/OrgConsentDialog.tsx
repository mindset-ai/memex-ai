import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from './AuthContext';
import { Button } from './ui/Button';
import {
  getPendingConsentApi,
  submitConsentDecisionsApi,
  type ConsentDecisionInput,
  type PendingConsentOrg,
  type PendingConsentResult,
} from '../api/client';

// t-13 of doc-15 — domain-based auto-join consent dialog (std-6).
//
// Mounted once at the top of the authenticated tree (App.tsx). On mount we hit
// GET /api/consent/pending; if the result has any `pending` orgs we render the
// consent prompt; if it has any `disabled` entries we render the "contact
// admin" notice (independent of pending — both lists can co-occur). The server
// is the source of truth for stickiness, so the dialog only renders when the
// API tells it to. After the user submits (or skips), we POST every entry —
// including unchecked rows as `declined` and an explicit Skip as `skipped` —
// then close. The server never re-prompts for resolved (user, org) pairs.

export interface OrgConsentDialogProps {
  // Test seam: lets the AppShell test suite mount the component with a
  // pre-built pending result without stubbing fetch. In production we always
  // fetch ourselves on mount.
  initialPending?: PendingConsentResult;
  // Test seam: notifies caller when the dialog is fully dismissed (no pending
  // + no disabled, or after submit). Kept optional to avoid coupling App.tsx.
  onDismissed?: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; pending: PendingConsentOrg[]; disabled: PendingConsentOrg[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

export function OrgConsentDialog({
  initialPending,
  onDismissed,
}: OrgConsentDialogProps = {}) {
  const { token, isAuthenticated } = useAuth();
  const [state, setState] = useState<LoadState>(() => {
    if (initialPending) {
      if (initialPending.pending.length === 0 && initialPending.disabled.length === 0) {
        return { kind: 'empty' };
      }
      return {
        kind: 'ready',
        pending: initialPending.pending,
        disabled: initialPending.disabled,
      };
    }
    return { kind: 'loading' };
  });
  // Map of orgId → checked. Default-yes per std-6 — the user can uncheck rows
  // they don't want to join.
  const [selections, setSelections] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Once the user has dismissed (skip / accept / decline-all) we collapse the
  // dialog locally so it doesn't re-render until the next session start. The
  // server-side stickiness means re-fetching would return an empty list anyway,
  // but this keeps the UI from flashing during the in-flight POST.
  const [dismissed, setDismissed] = useState(false);

  // Fetch on mount when no seed is provided. Don't run when unauthenticated —
  // the parent gates this, but defending here keeps the component reusable.
  useEffect(() => {
    if (initialPending) return;
    if (!isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getPendingConsentApi(token);
        if (cancelled) return;
        if (result.pending.length === 0 && result.disabled.length === 0) {
          setState({ kind: 'empty' });
          onDismissed?.();
          return;
        }
        setState({ kind: 'ready', pending: result.pending, disabled: result.disabled });
      } catch (err) {
        if (cancelled) return;
        // Swallow the error softly — auto-join consent is a nicety, not a
        // hard gate. Rendering nothing keeps the rest of the app usable. We
        // still log to the console so a regression is observable in dev.
        console.warn('[consent] failed to fetch pending', err);
        setState({ kind: 'empty' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialPending, isAuthenticated, token, onDismissed]);

  // Initialise default-yes selections whenever the pending list updates.
  useEffect(() => {
    if (state.kind !== 'ready') return;
    setSelections((prev) => {
      const next: Record<string, boolean> = {};
      for (const org of state.pending) {
        next[org.orgId] = prev[org.orgId] ?? true;
      }
      return next;
    });
  }, [state]);

  const toggle = useCallback((orgId: string) => {
    setSelections((prev) => ({ ...prev, [orgId]: !prev[orgId] }));
  }, []);

  const submit = useCallback(
    async (mode: 'confirm' | 'skip') => {
      if (state.kind !== 'ready') return;
      setSubmitting(true);
      setSubmitError(null);
      const decisions: ConsentDecisionInput[] = state.pending.map((org) => {
        if (mode === 'skip') return { orgId: org.orgId, response: 'skipped' as const };
        const checked = selections[org.orgId] ?? true;
        return {
          orgId: org.orgId,
          response: checked ? ('accepted' as const) : ('declined' as const),
        };
      });
      try {
        await submitConsentDecisionsApi(decisions, token);
        setDismissed(true);
        onDismissed?.();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Failed to submit');
        setSubmitting(false);
      }
    },
    [state, selections, token, onDismissed],
  );

  const dismissDisabledNotice = useCallback(() => {
    setDismissed(true);
    onDismissed?.();
  }, [onDismissed]);

  const visiblePending = useMemo(
    () => (state.kind === 'ready' ? state.pending : []),
    [state],
  );
  const visibleDisabled = useMemo(
    () => (state.kind === 'ready' ? state.disabled : []),
    [state],
  );

  if (dismissed) return null;
  if (state.kind === 'loading') return null;
  if (state.kind === 'empty' || state.kind === 'error') return null;

  // Two surfaces co-mounted: the consent prompt (only when `pending.length`)
  // and the disabled notice. They live in the same overlay so the user resolves
  // both at session start in one place.
  const showPending = visiblePending.length > 0;
  const showDisabled = visibleDisabled.length > 0;
  if (!showPending && !showDisabled) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="org-consent-title"
    >
      <div
        className="w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl"
        // Don't dismiss on backdrop click — std-6 wants a clear decision from
        // the user; click-out feels like an accidental "skip" with no record.
      >
        {showPending && (
          <>
            <div className="px-6 py-4 border-b border-edge">
              <h2
                id="org-consent-title"
                className="text-base font-semibold text-heading"
              >
                {visiblePending.length === 1
                  ? `Join ${visiblePending[0].name}?`
                  : 'Join your Org Memexes?'}
              </h2>
              <p className="mt-1 text-xs text-secondary">
                {visiblePending.length === 1
                  ? `Your email domain matches ${visiblePending[0].name}. Joining lets you collaborate on shared Specs and Standards.`
                  : 'Your email domain matches the following Orgs. Pick which ones to join.'}
              </p>
            </div>
            <div className="px-6 py-4 space-y-3">
              {visiblePending.map((org) => (
                <label
                  key={org.orgId}
                  className="flex items-start gap-3 cursor-pointer rounded-lg border border-edge bg-card-hover/40 hover:bg-card-hover px-3 py-2"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selections[org.orgId] ?? true}
                    onChange={() => toggle(org.orgId)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-primary truncate">
                      {org.name}
                    </div>
                    <div className="text-xs text-muted truncate">
                      {org.slug} · matched on @{org.domain}
                    </div>
                  </div>
                </label>
              ))}
              {submitError && (
                <div className="px-3 py-2 rounded-lg bg-status-danger-bg border border-status-danger-border text-sm text-status-danger-text">
                  {submitError}
                </div>
              )}
            </div>
          </>
        )}

        {showDisabled && (
          <div
            className={`px-6 py-4 ${showPending ? 'border-t border-edge' : ''} space-y-2`}
          >
            <div className="text-sm font-medium text-heading">
              {visibleDisabled.length === 1
                ? 'Removed from an Org Memex'
                : 'Removed from Org Memexes'}
            </div>
            <ul className="space-y-1.5">
              {visibleDisabled.map((org) => (
                <li key={org.orgId} className="text-xs text-secondary">
                  You were removed from <span className="text-primary">{org.name}</span>
                  . Contact an admin to be re-added.
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="px-6 py-4 border-t border-edge flex justify-end gap-2">
          {showPending ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => submit('skip')}
                disabled={submitting}
              >
                Skip
              </Button>
              <Button
                type="button"
                onClick={() => submit('confirm')}
                disabled={submitting}
              >
                {submitting ? 'Saving…' : 'Confirm'}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              onClick={dismissDisabledNotice}
              disabled={submitting}
            >
              Got it
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
