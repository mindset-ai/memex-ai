// spec-164 dec-1: the phase DISPLAY-NAME layer. The planning phase presents to
// users as "Specify" while the enum value, DB doc.status, MCP/agent vocabulary,
// scaffold prompts, and URL grammar all keep `plan` (per the std-19 amendment
// proposed alongside this spec). Every user-facing surface that prints a phase
// name routes through this map — the tab bar, the transition sentence, the
// phase directives, filters, badges, and list views.
//
// Deliberately NOT routed through here: agent-facing vocabulary surfaces
// (Scaffold Inspect, Init Prompt modes) where `plan` is the true value the
// agent sees, and non-spec doc statuses (approved etc.), which are not phases.

const PHASE_DISPLAY_NAMES: Record<string, string> = {
  draft: 'Draft',
  plan: 'Specify',
  build: 'Build',
  verify: 'Verify',
  done: 'Done',
};

/** The user-facing display name for a Spec phase. Unknown values fall back to
 * the capitalised raw string so non-phase statuses degrade gracefully. */
export function phaseDisplayName(phase: string): string {
  return (
    PHASE_DISPLAY_NAMES[phase] ??
    phase.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}
