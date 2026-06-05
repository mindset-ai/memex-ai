import { useChat } from './ChatContext';
import type { SpecPhase } from '@memex/shared';
import { Button } from './ui';

// doc-12 t-12: top-bar button that walks the user through unresolved comments
// on the Spec. Note the deliberate asymmetry with t-11's RefreshSpec:
// this button IS available in `draft` (per dec-13 of doc-12) — comment triage
// is useful even before the narrative is consolidatable.
//
// The counter is live because the parent (DocDocument) is already subscribed
// to the per-doc SSE stream and refetches comments on every change; we just
// receive the current count as a prop and re-render. No new wiring needed.
//
// Like t-11 this is a chat seed today; once `assess_spec({mode:'comments'})`
// (t-5 of doc-12) lands the agent will recognise the prompt and call the
// dedicated tool.

export interface ResolveCommentsButtonProps {
  phase: SpecPhase;
  /** Live count of unresolved comments across all targets (sections, decisions, tasks). */
  openCommentCount: number;
}

const RESOLVE_PROMPT =
  "Walk through the open comments on this Spec with me. For each one, propose a resolution and call update_comment(ref, { status: 'resolved', resolution }) when I confirm — the in-app agent already has the canonical comment refs.";

export function ResolveCommentsButton({
  phase,
  openCommentCount,
}: ResolveCommentsButtonProps) {
  const chat = useChat();

  if (phase === 'done') return null;
  if (openCommentCount <= 0) return null;

  // aria-label spells the count out for screen readers; the visual label uses
  // the parenthesised digit form which sighted users skim.
  const ariaLabel = `Resolve comments (${openCommentCount} open)`;

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-label={ariaLabel}
      onClick={() => chat.sendMessage(RESOLVE_PROMPT)}
    >
      Resolve Comments ({openCommentCount})
    </Button>
  );
}
