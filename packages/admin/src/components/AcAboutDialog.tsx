// AcAboutDialog — the "what is this view?" modal triggered by the info
// button next to the framing line on the AC tab.
//
// The audience hasn't seen this paradigm before. Unit tests have always been
// "did the author write what they meant"; this view is about whether the
// running code still honours the team's STATED INTENT — a different chain
// (intent → code → test → ongoing confirmation). The framing line at the
// top of the tab plants the seed; this dialog is where a curious manager
// goes to learn the whole picture.
//
// Grounded-in-data principle: every paragraph references concrete counts
// from the current Spec where it can, so the explanation reads as "about
// THIS Spec" rather than generic boilerplate. If the Spec is empty
// (no ACs / no tests yet), the language gracefully degrades to forward-
// facing.
//
// Word choice: deliberately avoids "emit" — the audience reads test events
// as "messages sent to Memex", which is closer to how it feels.

import { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import type { AcWithVerification } from '../api/client';

interface AcAboutDialogProps {
  rows: AcWithVerification[];
  onClose: () => void;
}

export function AcAboutDialog({ rows, onClose }: AcAboutDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Live counts from the current Spec — grounds the prose so the modal
  // reads as "about THIS Spec", not generic copy.
  const scope = rows.filter((r) => r.ac.kind === 'scope');
  const impl = rows.filter((r) => r.ac.kind === 'implementation');
  const covered = rows.filter((r) => r.tests.length > 0);
  const verified = rows.filter((r) => r.verificationState === 'verified');
  const failing = rows.filter((r) => r.verificationState === 'failing');
  const untested = rows.filter((r) => r.verificationState === 'untested');
  const stale = rows.filter((r) => r.verificationState === 'stale');
  const distinctTestIds = new Set<string>();
  for (const r of rows) {
    for (const t of r.tests) {
      distinctTestIds.add(t.testIdentifier ?? `<anon-${r.canonicalRef}>`);
    }
  }

  const hasData = rows.length > 0;
  const hasTests = covered.length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm overflow-y-auto py-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[640px] max-w-[92vw] rounded-xl border border-edge bg-panel shadow-2xl my-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h2 className="text-sm font-semibold text-heading">
            About this view — Acceptance Criteria
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
            aria-label="Close"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 text-sm text-body space-y-4 max-h-[70vh] overflow-y-auto">
          <p>
            An <span className="font-semibold">acceptance criterion (AC)</span>{' '}
            is a forward-facing claim about what your system must do — written
            in language a test can check. This Spec
            {hasData ? (
              <>
                {' '}currently carries{' '}
                <span className="font-semibold">{rows.length} AC{rows.length === 1 ? '' : 's'}</span>
                {scope.length > 0 && impl.length > 0 && (
                  <>
                    {' '}({scope.length} scope, {impl.length} implementation)
                  </>
                )}
                .
              </>
            ) : (
              <> has no acceptance criteria yet.</>
            )}
          </p>

          <div>
            <h3 className="font-semibold text-heading mb-1">
              Two flavours, two audiences
            </h3>
            <p className="mb-2">
              ACs come in two kinds. They share a shape but speak to different
              readers and enter the workflow at different points.
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <span className="font-medium">Scope ACs</span> are plain-English
                outcome commitments — written by you, the manager, with the
                Spec. They define what success looks like in language the
                business reads.
                {scope.length > 0 ? (
                  <>
                    {' '}This Spec has{' '}
                    <span className="font-semibold">{scope.length}</span> of
                    them.
                  </>
                ) : (
                  <> This Spec has none yet — they're typically the first ACs you write.</>
                )}
              </li>
              <li>
                <span className="font-medium">Implementation ACs</span> are
                technical, mechanism-shaped assertions — typically spawned by
                the agent from each resolved Decision. They're the granular
                claims that, taken together, fulfil the Scope ACs.
                {impl.length > 0 && (
                  <>
                    {' '}This Spec has{' '}
                    <span className="font-semibold">{impl.length}</span>.
                  </>
                )}
              </li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold text-heading mb-1">
              How the codebase tells Memex what's still aligned
            </h3>
            <p className="mb-2">
              Each AC can be paired with one or more tests in your codebase.
              Whenever those tests run — locally, in CI, on a pre-commit hook
              — they{' '}
              <span className="font-medium">send a message to Memex</span>{' '}
              saying which AC they were asserting and whether they passed or
              failed. The workspace records every message and uses the
              <em>latest</em> result per test as the live truth: code, ACs and
              the Spec are either still in alignment, or they've drifted and
              this view will show you which.
            </p>
            <p>
              Tests stay in the codebase — Memex doesn't own them. The
              message a test sends is a tiny POST containing the AC's
              canonical reference, the pass/fail outcome, and the test's
              identifier. The Vitest helper is published on npm as{' '}
              <code className="text-xs">@memex-ai-ac/vitest</code>
              ; ports to other frameworks (Jest, pytest) follow the same
              wire format.
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-heading mb-1">
              What this view shows
            </h3>
            {hasTests ? (
              <p>
                {distinctTestIds.size} distinct test
                {distinctTestIds.size === 1 ? '' : 's'} in your codebase
                {' '}{distinctTestIds.size === 1 ? 'is' : 'are'} currently
                reporting on this Spec. Of the {rows.length} AC
                {rows.length === 1 ? '' : 's'},{' '}
                <span className="text-green-600 dark:text-green-400 font-medium">
                  {verified.length} {verified.length === 1 ? 'is' : 'are'} currently verified
                </span>
                {failing.length > 0 && (
                  <>
                    {', '}
                    <span className="text-zinc-500 dark:text-zinc-400 font-medium">
                      {failing.length} {failing.length === 1 ? 'is' : 'are'} failing
                    </span>
                  </>
                )}
                {stale.length > 0 && (
                  <>
                    {', '}
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      {stale.length} {stale.length === 1 ? 'is' : 'are'} stale
                    </span>{' '}
                    (verified but not re-checked in over a week)
                  </>
                )}
                {untested.length > 0 && (
                  <>
                    , and{' '}
                    <span className="text-amber-600 dark:text-amber-400 font-medium">
                      {untested.length} {untested.length === 1 ? 'is' : 'are'} not yet linked
                    </span>{' '}
                    to any test.
                  </>
                )}
                {untested.length === 0 && '.'}
              </p>
            ) : hasData ? (
              <p>
                ACs exist on this Spec but no test has yet reported on any of
                them. This is the normal starting state — the next step is
                wiring tests in the codebase to each AC. Ask the embedded
                agent for help, or consult the{' '}
                <code className="text-xs">ac-emission</code> topic via the
                {' '}<code className="text-xs">get_information</code> tool.
              </p>
            ) : (
              <p>
                Once Scope ACs are authored and Implementation ACs are spawned
                from resolved Decisions, this view will summarise their
                alignment with the codebase at a glance.
              </p>
            )}
            <p className="mt-2">
              Two metrics lead each section:{' '}
              <span className="font-medium">coverage</span> (what fraction of
              ACs have any test at all) and{' '}
              <span className="font-medium">verification</span> (what fraction
              of covered ACs are currently passing). Coverage is upstream — an
              AC with no test can't be verified, and a low coverage number is
              an invitation to either write more tests or drop ACs that are no
              longer load-bearing.
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-heading mb-1">
              The trajectory matters
            </h3>
            <p>
              The sparkline at the top of each section shows how alignment has
              moved over the last 30 days. Hover any day to see the exact
              numbers. A flat green line is the best news; a steady decline is
              a signal worth a conversation with the agent before it becomes a
              real drift event.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-edge">
          <Button size="sm" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
