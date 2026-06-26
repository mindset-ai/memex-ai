// spec-336 — step 5 "Go build" (BUILDER-ONLY, terminal), v2 flat layout. The spec is
// complete: decisions resolved, acceptance criteria testable, tasks queued and a test
// behind each one. Hand it over and the plan executes, with every change checked back
// against intent. Terminal: no milestone to wait on — its rail orb ticks once every prior
// step is attained (the server's all-milestones-met terminal rule).
import { CodeBlock } from '../CodeBlock';
import { SPEC_TOKEN_PLACEHOLDER } from './specToken';

// spec-372 issue-16 — kept a BUILD prompt; only {spec} is injected at render with the user's
// real spec handle (or a fill-in placeholder); see specToken.ts / resolveSpecToken.
const GO_BUILD_PROMPT = `Using the Memex MCP — the plan for {spec} is complete: decisions resolved,
acceptance criteria set, tasks queued and a test behind each one.

Now build it. Work through the tasks in order: implement each one,
run its tests, and report progress back to Memex as you go.

Go build.`;

export function AgentsBuildStep({
  onCtaClick,
  specToken = SPEC_TOKEN_PLACEHOLDER,
}: {
  onCtaClick?: (target: string) => void;
  // spec-372 issue-16 — the real spec handle (or placeholder) injected into the prompt.
  specToken?: string;
} = {}) {
  return (
    <div data-testid="journey-step-agents-build" className="max-w-3xl animate-[panelIn_0.35s_ease]">
      <h2 className="onboarding-heading mb-5">Agents build in lockstep</h2>
      {/* Design copy reads "One coordinated team on your tasks." — reworded to avoid the
          reserved product noun "team" that std-1's UI copy sweep forbids (a metaphor here,
          not the workspace concept). Same meaning, no reserved noun. */}
      {/* spec-372 t-13 — v3 sub-tagline weight is 600 (semibold), not bold. */}
      <p className="mb-5 text-xl font-semibold leading-snug text-primary">One coordinated effort across your tasks.</p>
      <p className="mb-7 max-w-2xl leading-relaxed text-secondary">
        Your spec is complete — decisions resolved, acceptance criteria testable, tasks queued and tests in place. Hand
        it over and the plan executes, with every change checked back against what you intended.
      </p>

      <div data-testid="agents-build-prompt">
        <CodeBlock code={GO_BUILD_PROMPT.replace('{spec}', specToken)} onCopy={() => onCtaClick?.('copy_prompt')} />
      </div>
    </div>
  );
}
