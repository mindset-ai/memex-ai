// spec-242 t-3 (dec-4) — "Here's how you get the most out of Memex AI".
//
// The final page of the first-run Specky dialogue: three numbered, tinted info
// cards, copy verbatim from the design (Figma 590-1855, one typo fixed — "for
// you to try"). Explicitly NOT a checklist (ac-3/ac-13): static text only — no
// links, buttons, checkboxes, state detection, or completion ticks. The
// builder-vs-reviewer call rides the MCP card's opening line ("If you write
// code, do this first.") rather than any persona picker (dec-4 / ac-4).
//
// std-34 note: the MCP card points the user at the in-browser setup page
// (Settings → Integrations, route /settings/integrations) — it names no MCP
// tool and describes no MCP-only action as in-browser; the handoff affordances
// live on that page.

export const VALUE_INTRO_HEADING = "Here's how you get the most out of Memex AI";

export const VALUE_INTRO_ITEMS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Connect your coding agent',
    body: 'If you write code, do this first. Connect your agent via MCP to create and work on specs directly from your coding environment. Find the setup in your profile under Integrations.',
  },
  {
    title: 'Walk through the demo spec',
    body: "We've set up a demo spec in your personal Memex, ready and waiting for you to try in the draft column.",
  },
  {
    title: 'Work with your team',
    body: 'Set up your own org, or ask your Memex admin to invite you to theirs.',
  },
];

export function ValueIntroPanel() {
  return (
    <div data-testid="value-intro-panel" className="flex flex-col gap-3">
      {VALUE_INTRO_ITEMS.map((item, i) => (
        <div key={item.title} className="rounded-lg bg-accent/10 p-4">
          <h3 className="text-sm font-semibold text-heading">
            {i + 1}. {item.title}
          </h3>
          <p className="mt-1.5 text-sm text-secondary">{item.body}</p>
        </div>
      ))}
    </div>
  );
}
