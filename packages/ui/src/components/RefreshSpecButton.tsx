import { useChat } from './ChatContext';
import type { Decision, SpecStatus } from '../api/types';
import { isSpecNarrativeStale as sharedIsSpecNarrativeStale } from '@memex/shared';
import { Button } from './ui';

// doc-12 t-11: surfaces a "Refresh Spec" affordance on the Spec top bar
// when the narrative is out of date relative to the decisions graph. The
// staleness check is intentionally client-side — the server already returns
// `narrativeLastConsolidatedAt` on the doc payload and the decisions list is
// already loaded for the Decisions tab, so there's nothing to fetch.
//
// On click we just seed a chat message; the agent answers from the existing
// document context. The actual `assess_spec({mode:'narrative'})` server tool
// (t-4 of doc-12) ships and the agent picks it up automatically because the
// seed prompt names the workflow it's expected to run.
//
// Visibility (per t-11 spec):
//   - phase ∉ {draft, done} — no point consolidating an empty draft, and a
//     done Spec is read-only.
//   - at least one decision was created or resolved AFTER the consolidation
//     timestamp (or the Spec has never been consolidated at all).

export interface RefreshSpecButtonProps {
  phase: SpecStatus;
  /** Server-side timestamp; null = never consolidated. */
  narrativeLastConsolidatedAt: string | null | undefined;
  decisions: Decision[];
}

// spec-196 dec-3: the approved consolidation prompt. Kept verbatim in sync
// with the scaffold's `opening-refresh-narrative` node (scaffold-data.ts),
// which is the LIVE home of this copy — this component is currently unmounted
// (the opening-turn helper superseded the top-bar button, spec-123).
const REFRESH_PROMPT =
  'Update the spec narrative — walk every decision modified since the last consolidation and update the affected sections so the narrative reflects what was decided.';

// Doc-12 DRY refactor: the staleness rule (max(createdAt, resolvedAt) >
// narrativeLastConsolidatedAt) lives in @memex/shared/spec-readiness so
// the React UI and the server's MCP/agent surface both compute it the same
// way. We keep this re-export so existing callers (and tests) of
// `isSpecNarrativeStale` from this module's public surface still work.
export function isSpecNarrativeStale(
  narrativeLastConsolidatedAt: string | null | undefined,
  decisions: Decision[],
): boolean {
  return sharedIsSpecNarrativeStale(narrativeLastConsolidatedAt, decisions);
}

export function RefreshSpecButton({
  phase,
  narrativeLastConsolidatedAt,
  decisions,
}: RefreshSpecButtonProps) {
  const chat = useChat();

  if (phase === 'draft' || phase === 'done') return null;
  if (!isSpecNarrativeStale(narrativeLastConsolidatedAt, decisions)) return null;

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-label="New decisions — update spec narrative"
      onClick={() => chat.sendMessage(REFRESH_PROMPT)}
    >
      New decisions — update spec narrative
    </Button>
  );
}
