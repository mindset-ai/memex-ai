// spec-305 — the ONBOARDING journey's step views (supersedes spec-303's v0 views).
// One view per journey state; the Home Canvas engine renders the view for the step
// the server says the user is on. The journey is MCP-first and ends at a GREEN AC.
// The `identity` step is rendered by a custom component (IdentityStep) in HomeCanvas,
// so its entry here carries only a map label, never a rendered view.
import type { JourneyStepView } from '../types';

// The server-derived steps a user can land on, in order (mirrors the server's
// journeys/onboarding.ts).
export const ONBOARDING_MILESTONE_STEP_IDS = [
  'welcome',
  'identity',
  'connect-agent',
  'create-spec',
  'resolve-decision',
  'add-ac',
  'see-green',
  'all-set',
] as const;

export const ONBOARDING_STEP_VIEWS: Record<string, JourneyStepView> = {
  welcome: {
    id: 'welcome',
    mapLabel: 'Welcome',
    greetingHeading: true,
    headline: (
      <>
        Welcome to Memex.
        <span className="block">
          Your plan and your build{' '}
          <span className="bg-[linear-gradient(96deg,#fb5b78,#c084fc)] bg-clip-text text-transparent">
            drift apart
          </span>{' '}
          the moment you write them.
        </span>
      </>
    ),
    // Beat 1 (dec-6): a universal, role-agnostic cold open about the shared enemy —
    // drift. The coder-specific ".md files are dead" line is a Beat-2 reward shown
    // AFTER the user tells us their role, not in the cold open.
    body: 'Memex keeps intent and code in lockstep: one living source your agent reads, follows, and proves it honoured.',
    primary: { label: 'Get started', kind: 'navigate', target: 'identity' },
    secondary: { label: 'Why Memex?', kind: 'navigate', target: 'learn-more' },
  },

  // Map label only — the identity step is rendered by IdentityStep (HomeCanvas), so
  // these headline/primary fields are never shown.
  identity: {
    id: 'identity',
    mapLabel: 'You',
    headline: '',
    primary: { label: 'Continue', kind: 'navigate', target: 'identity' },
  },

  // Informational (navigate-only) — not a server milestone step.
  'learn-more': {
    id: 'learn-more',
    eyebrow: "// what's a spec?",
    headline: 'A spec is a living plan.',
    sub: 'Not a doc that rots: a plan your agent reads and follows.',
    body: 'A spec captures what you are building and why — the decisions it hinges on, what "done" means, and the work to get there. Your coding agent reads it over MCP, so it builds the right thing and stays on track.',
    primary: { label: 'Get started', kind: 'navigate', target: 'identity' },
    secondary: { label: 'Back', kind: 'navigate', target: 'welcome' },
  },

  'connect-agent': {
    id: 'connect-agent',
    mapLabel: 'Agent connected',
    eyebrow: '// 01 · connect your agent',
    headline: 'Bring your coding agent.',
    sub: 'One connection, and your agent works straight from your plan.',
    body: 'Connect your agent over MCP and it can read your specs, standards and decisions, and report progress back. One command and you are wired in — from here, your agent does the work while you watch it land.',
    primary: { label: 'Connect your agent', kind: 'action', target: 'connect_agent' },
    secondary: { label: "What's the MCP?", kind: 'link', target: 'https://www.memex.ai' },
  },

  'create-spec': {
    id: 'create-spec',
    mapLabel: 'Spec created',
    eyebrow: '// 02 · first spec',
    headline: 'Hand your agent its first spec.',
    sub: 'Bring a PRD, or use ours and follow along.',
    body: 'Paste the prompt into your connected agent and it creates a spec in your personal Memex — point it at a real PRD/markdown file, or use our sample to learn the ropes.',
    primary: { label: 'Create your first spec', kind: 'action', target: 'create_spec' },
    secondary: { label: 'Open your Specs', kind: 'action', target: 'open_specs' },
  },

  'resolve-decision': {
    id: 'resolve-decision',
    mapLabel: 'Decision made',
    eyebrow: '// 03 · first decision',
    headline: 'Make the first real call.',
    sub: 'Every plan hinges on a few decisions.',
    body: 'Capture the choice your spec turns on, weigh the options, and resolve it. That is how the plan stays honest and your agent knows which path you picked.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
    secondary: { label: 'How decisions work', kind: 'link', target: 'https://www.memex.ai' },
  },

  'add-ac': {
    id: 'add-ac',
    mapLabel: 'AC added',
    eyebrow: '// 04 · define "done"',
    headline: 'Pin down what "done" means.',
    sub: 'An acceptance criterion turns intent into something testable.',
    body: 'Add an acceptance criterion to your decision — a plain statement of what the code must do. This is the promise your tests will hold the build to.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
  },

  'see-green': {
    id: 'see-green',
    mapLabel: 'AC green',
    eyebrow: '// 05 · the moment',
    headline: 'Watch it go green.',
    sub: 'Your agent emits a test result, and the AC lights up.',
    body: 'Have your agent run the test that backs your acceptance criterion. When it passes, the AC turns green right here — provable alignment between what you intended and what the code does. This is Memex.',
    primary: { label: 'Open your spec', kind: 'action', target: 'open_specs' },
  },

  'all-set': {
    id: 'all-set',
    mapLabel: 'Set up',
    eyebrow: '// done',
    headline: "You're all set.",
    sub: 'You drove a spec from intent to a green AC. That is the whole loop.',
    body: 'From here, Home shows what needs your attention next. When you are ready, bring your colleagues in — set up an organisation (free) so the map grows with the people you work with.',
    primary: { label: 'Invite colleagues', kind: 'action', target: 'invite' },
    secondary: { label: 'Back to your Specs', kind: 'action', target: 'open_specs' },
  },
};
