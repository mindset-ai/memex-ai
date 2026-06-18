// spec-303 — the ONBOARDING journey's step views (dec-1: a self-contained module).
// One view per journey state; the Home Canvas engine renders the view for the
// step the server says the user is on. Editing this journey touches only this
// folder. The brand-new step is the "MD files are dead" splash.
import type { JourneyStepView } from '../types';

// The server-derived steps a user can land on, in order (mirrors the server's
// journeys/onboarding.ts). Used by the operator preview control.
export const ONBOARDING_MILESTONE_STEP_IDS = [
  'welcome',
  'first-decision',
  'connect-agent',
  'use-agent',
  'all-set',
] as const;

export const ONBOARDING_STEP_VIEWS: Record<string, JourneyStepView> = {
  welcome: {
    id: 'welcome',
    mapLabel: 'Spec created',
    greetingHeading: true,
    headline: (
      <>
        Welcome to Memex.
        <span className="block">
          We believe that{' '}
          <span className="text-muted line-through decoration-[#fb5b78] decoration-4">
            .md files
          </span>{' '}
          are{' '}
          <span className="bg-[linear-gradient(96deg,#fb5b78,#c084fc)] bg-clip-text text-transparent">
            dead
          </span>
          .
        </span>
      </>
    ),
    // Placeholder on purpose (internal v1): the COPY here is not yet decided —
    // colleagues should react to the journey CONCEPT, not this wording.
    body: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
    primary: { label: 'Create your first spec', kind: 'action', target: 'create_spec' },
    secondary: { label: 'Why Memex?', kind: 'navigate', target: 'learn-more' },
  },

  // Informational (navigate-only) — not a server milestone step.
  'learn-more': {
    id: 'learn-more',
    eyebrow: "Memex · What's a spec?",
    headline: 'A spec is a living plan.',
    sub: 'Not a doc that rots: a plan your agent reads and follows.',
    body: 'A spec captures what you are building and why — the decisions it hinges on, what "done" means, and the work to get there. Your coding agent reads it over MCP, so it builds the right thing and stays on track.',
    primary: { label: 'Create your first spec', kind: 'action', target: 'create_spec' },
    secondary: { label: 'Back', kind: 'navigate', target: 'welcome' },
  },

  'first-decision': {
    id: 'first-decision',
    mapLabel: 'Decision made',
    eyebrow: 'Memex · Next',
    headline: 'Your spec is alive. Now make the call.',
    sub: 'Every plan hinges on a few real decisions.',
    body: 'Capture the choice your spec turns on as a decision, weigh the options, and resolve it. That is how the plan stays honest and your agent knows which path you picked.',
    primary: { label: 'Capture a decision', kind: 'action', target: 'create_decision' },
    secondary: { label: 'How decisions work', kind: 'link', target: 'https://www.memex.ai' },
  },

  'connect-agent': {
    id: 'connect-agent',
    mapLabel: 'Agent connected',
    eyebrow: 'Memex · Next',
    headline: 'Bring your coding agent.',
    sub: 'Memex is where your agent gets its marching orders.',
    body: 'Connect your agent over MCP and it can read your specs, standards and decisions, and report its progress back. One command and you are wired in.',
    primary: { label: 'Connect your agent', kind: 'action', target: 'connect_agent' },
    secondary: { label: "What's the MCP?", kind: 'link', target: 'https://www.memex.ai' },
  },

  'use-agent': {
    id: 'use-agent',
    mapLabel: 'Agent used',
    eyebrow: 'Memex · Next',
    headline: 'Put your agent to work.',
    sub: 'Hand it a spec and watch it build.',
    body: 'Your agent is connected. Open your Specs board, hand it the spec you created, and let it work the plan — every step tracked against what you agreed.',
    primary: { label: 'Open your Specs board', kind: 'action', target: 'open_specs' },
  },

  'all-set': {
    id: 'all-set',
    mapLabel: 'Set up',
    eyebrow: "Memex · You're set up",
    headline: "You're all set.",
    sub: 'You have driven a spec end to end. This is Memex.',
    body: 'From here, Home shows you what needs your attention next. Bring your colleagues in so the map grows with you.',
    primary: { label: 'Invite your org', kind: 'action', target: 'invite' },
    secondary: { label: 'Back to your Specs', kind: 'action', target: 'open_specs' },
  },
};
