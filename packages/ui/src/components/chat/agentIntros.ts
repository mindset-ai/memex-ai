// spec-389 t-1 (dec-1): the static, no-LLM intro cards — one per in-app agent
// mode, single-sourced here so every surface (spec, drift, standards, issues,
// scaffold) shows the SAME shaped intro instead of a money-costing opening LLM
// turn on load (ac-1/ac-5). The first real LLM call happens only when the user
// types. This is human-facing UI copy (not agent prompt prose), so it lives in
// the UI rather than the scaffold model.

/** The in-app agent modes that render in the shared ChatPanel shell. */
export type AgentChatMode = 'spec' | 'drift' | 'scaffold' | 'standards' | 'issues';

export interface AgentIntroContent {
  /** One-line statement of what this agent is for. */
  lead: string;
  /** A few concrete things the user can ask / do. */
  bullets: string[];
  /** The closing nudge to start. */
  footer?: string;
}

const START = 'Type a question below to start.';

// Each agent's awareness is broad (it can read the whole Memex) but its
// authority is narrow (it authors only within its own function) — the intros
// reflect that scoping so the user knows what each agent owns.
export const AGENT_INTROS: Record<AgentChatMode, AgentIntroContent> = {
  spec: {
    lead: 'I help you shape this Spec — its narrative, decisions, and acceptance criteria.',
    bullets: [
      'Ask me to explain or edit any section, decision, or AC on this Spec.',
      'Ask what the team has decided elsewhere — I search the whole Memex first.',
      'I work on this Spec only; for a Standard or a new Spec I’ll hand you a prompt for the right agent.',
    ],
    footer: START,
  },
  drift: {
    lead: 'I help you understand and handle drift between your Standards and the reality they describe.',
    bullets: [
      'Ask me to summarise the open drift, grouped by Standard.',
      'I can resolve an observation, or record / apply a proposed rule change.',
      'I work on Standards drift only — I propose every change before it’s written.',
    ],
    footer: START,
  },
  scaffold: {
    lead: 'I explain the prompting every agent in this Memex reads — and help admins shape it.',
    bullets: [
      'Ask what an agent reads at any phase, gate, tool, or button — I’ll jump the view to it.',
      'Ask why a piece of guidance exists, or where an org rule applies.',
      'Admins: ask me to add, edit, or remove your org’s guidance — I draft it for your approval.',
    ],
    footer: START,
  },
  standards: {
    lead: 'I help you explore, navigate, and author this Memex’s Standards.',
    bullets: [
      'Ask “which Standards govern auth?” or “what does std-7 mean?” — I search and explain.',
      'I can navigate you to a Standard’s clause and quote its exact text.',
      'I author Standards only; every edit is proposed for your confirmation first.',
    ],
    footer: START,
  },
  issues: {
    lead: 'I help you triage and manage the Issues parking lot across this Memex.',
    bullets: [
      'Ask me to summarise open Issues, or filter them by Spec or type.',
      'I can update, resolve, or promote a todo Issue straight to a Task.',
      'I manage Issues only; when something needs a Spec I’ll hand you a prompt for the New Spec flow.',
    ],
    footer: START,
  },
};
