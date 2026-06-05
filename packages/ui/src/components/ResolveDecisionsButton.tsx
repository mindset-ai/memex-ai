import { useChat } from './ChatContext';
import type { SpecPhase } from '@memex/shared';
import { Button } from './ui';

// doc-12: surfaces a "Resolve Decisions" affordance on the Spec top bar when
// there are unresolved decisions on the Spec. The agent walks the user
// through each one — listing context, options, trade-offs, and asking for the
// call. Mirrors `ResolveCommentsButton` and `RefreshSpecButton` so the three
// outstanding-work affordances feel consistent.
//
// Visibility: count > 0 AND phase ∈ {draft, plan, build, verify}. Hidden in
// `done` because a closed Spec is read-only.

export interface ResolveDecisionsButtonProps {
  phase: SpecPhase;
  openDecisionCount: number;
}

const RESOLVE_DECISIONS_PROMPT =
  'Walk through the open decisions on this Spec with me. For each one, summarise the context, options and trade-offs, recommend if you can, then ask me for the call and call resolve_decision when I confirm.';

export function ResolveDecisionsButton({
  phase,
  openDecisionCount,
}: ResolveDecisionsButtonProps) {
  const chat = useChat();

  if (phase === 'done') return null;
  if (openDecisionCount <= 0) return null;

  const decisionLabel = openDecisionCount === 1 ? 'Decision' : 'Decisions';

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      aria-label={`Resolve decisions (${openDecisionCount} open)`}
      onClick={() => chat.sendMessage(RESOLVE_DECISIONS_PROMPT)}
    >
      Resolve {decisionLabel} ({openDecisionCount})
    </Button>
  );
}
