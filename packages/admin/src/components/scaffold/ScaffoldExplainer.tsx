// b-68 t-12 / s-7: Overview pane content. A system-level explainer of how the
// scaffold composes — the 5 phases, the two-agent parity rule, how nudges
// stack on tool responses, and what Org additions do. Per ac-15 this is the
// per-page explainer that lives alongside per-node rationales.

const PHASES: { phase: string; one_liner: string }[] = [
  { phase: 'draft', one_liner: 'private authoring — sketch purpose and shape, no tasks yet.' },
  { phase: 'plan', one_liner: 'team-visible decision resolution and narrative shaping.' },
  { phase: 'build', one_liner: 'execute against decisions; tasks are first-class.' },
  { phase: 'verify', one_liner: 'post-implementation confidence — walk acceptance criteria.' },
  { phase: 'done', one_liner: 'read-only retrospective; the Spec is closed.' },
];

export function ScaffoldExplainer() {
  return (
    <div data-testid="scaffold-explainer" className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-heading">Inspect the scaffold</h1>
        <p className="text-sm text-secondary mt-2">
          The scaffold is the bag of prompt prose, tool descriptions, nudges, and gate
          rubrics that every Memex agent (React-embedded and MCP) operates against. One
          model, many projections — what shows up below is exactly what the agent reads,
          plus the rationale for why each block exists.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-heading">The five phases</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {PHASES.map((p) => (
            <li key={p.phase}>
              <code className="font-mono font-semibold">{p.phase}</code> — {p.one_liner}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-heading">Two-agent parity</h2>
        <p className="mt-2 text-sm">
          The React-embedded agent and the MCP-driven agent receive the same nudge text
          for every (tool, phase) pair, and the same gate rubric for every forward
          transition. Surface-specific content (MDX components, the <code>render_*</code>{' '}
          UI tools) ships <em>only</em> to the React surface; everything behavioural rides
          the shared nudge channel.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-heading">How nudges compose</h2>
        <p className="mt-2 text-sm">
          When a tool returns a result, the runtime composes a nudge: the base
          guidance whose <code>target</code> matches the current (tool, phase) context,
          followed by the enabled Org guidance with the same match. Absent target
          dimensions match every value (an empty <code>target</code> = global). The
          composed text reads as one coherent set of guidance, not a layered one —
          there is no &ldquo;base wins&rdquo; preamble.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-heading">What Org additions do</h2>
        <p className="mt-2 text-sm">
          Administrators can append Org guidance against any target shape: a phase, a
          tool, a (tool, phase) pair, or a transition gate. Org additions never replace
          base prose — they extend it. Toggle <code>enabled</code> off to disable an
          Org block without deleting it. Edits propagate to live agents within a
          handful of seconds via the std-8 cache-invalidation bus.
        </p>
      </section>
    </div>
  );
}
