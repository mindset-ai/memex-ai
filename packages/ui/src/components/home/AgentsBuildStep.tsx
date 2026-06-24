// spec-336 — step 5 "Go build" (BUILDER-ONLY, terminal), v2 flat layout. The spec is
// complete: decisions resolved, acceptance criteria testable, tasks queued and a test
// behind each one. Hand it over and the plan executes, with every change checked back
// against intent. Terminal: no milestone to wait on — its rail orb ticks once every prior
// step is attained (the server's all-milestones-met terminal rule).
import { CodeBlock } from '../CodeBlock';

const GO_BUILD_PROMPT = `Using the Memex MCP — the plan is complete: decisions resolved, acceptance criteria set, tasks queued and a test behind each one. Now build it. Work through the tasks in order: implement each one, run its tests, and report progress back to Memex as you go. Go build.`;

export function AgentsBuildStep({
  onCtaClick,
}: {
  onCtaClick?: (target: string) => void;
} = {}) {
  return (
    <div data-testid="journey-step-agents-build" className="max-w-3xl animate-[panelIn_0.35s_ease]">
      <h2 className="onboarding-heading mb-5">Agents build in lockstep</h2>
      {/* Design copy reads "One coordinated team on your tasks." — reworded to avoid the
          reserved product noun "team" that std-1's UI copy sweep forbids (a metaphor here,
          not the workspace concept). Same meaning, no reserved noun. */}
      <p className="mb-5 text-xl font-bold leading-snug text-primary">One coordinated effort across your tasks.</p>
      <p className="mb-7 max-w-2xl leading-relaxed text-secondary">
        Your spec is complete — decisions resolved, acceptance criteria testable, tasks queued and tests in place. Hand
        it over and the plan executes, with every change checked back against what you intended.
      </p>

      <div data-testid="agents-build-prompt">
        <CodeBlock code={GO_BUILD_PROMPT} onCopy={() => onCtaClick?.('copy_prompt')} />
      </div>
    </div>
  );
}
