// b-68 t-12 / s-7: Overview pane content. A system-level explainer of how the
// scaffold composes — the 5 phases, the handoffs, the two-agent parity rule, how
// nudges stack on tool responses, and what Org additions do. Per ac-15 this is
// the per-page explainer that lives alongside per-node rationales.
//
// spec-360: it now leads with the scaffold ASSISTANT (the chat agent in the left
// rail) and carries an admin/view-only badge, since this is the page's empty
// state — the first thing a viewer reads.

const PHASES: { phase: string; one_liner: string }[] = [
  { phase: 'draft', one_liner: 'private authoring — sketch purpose and shape, no tasks yet.' },
  { phase: 'specify', one_liner: 'team-visible decision resolution and narrative shaping.' },
  { phase: 'build', one_liner: 'execute against decisions; tasks are first-class.' },
  { phase: 'verify', one_liner: 'post-implementation confidence — walk acceptance criteria.' },
  { phase: 'done', one_liner: 'read-only retrospective; the Spec is closed.' },
];

interface ScaffoldExplainerProps {
  /** spec-360: when set, drives the admin/view-only badge + the authoring copy.
   *  Omitted (undefined) hides the badge — the capability isn't yet resolved. */
  isAdmin?: boolean;
}

function RoleBadge({ isAdmin }: { isAdmin: boolean }) {
  return isAdmin ? (
    <span
      data-testid="scaffold-role-badge"
      data-role="admin"
      className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent"
    >
      <span aria-hidden="true">●</span> Administrator — you can edit guidance
    </span>
  ) : (
    <span
      data-testid="scaffold-role-badge"
      data-role="viewer"
      className="inline-flex items-center gap-1.5 rounded-full border border-default bg-muted/20 px-2.5 py-0.5 text-xs font-medium text-secondary"
    >
      <span aria-hidden="true">●</span> View only — an administrator can edit guidance
    </span>
  );
}

export function ScaffoldExplainer({ isAdmin }: ScaffoldExplainerProps = {}) {
  return (
    <div data-testid="scaffold-explainer" className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-heading">Inspect the scaffold</h1>
          {isAdmin !== undefined ? <RoleBadge isAdmin={isAdmin} /> : null}
        </div>
        <p className="text-sm text-secondary mt-2">
          The scaffold is the backbone of the prompting that drives how Memex talks to your
          coding agents — the prompt prose, tool guidance, nudges, and gate rubrics every
          agent (in-app and over MCP) reads at each step of a Spec&rsquo;s life. It&rsquo;s
          what keeps an agent doing the right thing at the right moment.
        </p>
        <p className="text-sm text-secondary mt-2">
          Your org&rsquo;s additions layer your own workflows onto that shared base —
          without forking it — so the same rules reach every agent on every Spec. That&rsquo;s
          how you drive <strong>uniformity and compliance</strong> in how your org works with
          coding agents. Everything below is exactly what the agent reads, plus the rationale
          for why each block exists.
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-heading">The scaffold assistant</h2>
        <p className="mt-2 text-sm">
          The assistant in the left rail is your guide to this scaffold. Ask it what any
          agent reads at a given moment and it will <strong>navigate you</strong> to that
          circumstance and walk you through it, quoting the exact prompting where it
          helps.{' '}
          {isAdmin ? (
            <>
              Because you&rsquo;re an administrator, you can also ask it to{' '}
              <strong>change your org&rsquo;s guidance</strong> — it drafts the addition,
              edit, or removal as a proposal and shows it composed in place; nothing is
              written until you approve it.
            </>
          ) : (
            <>
              Administrators can also ask it to <strong>change the org&rsquo;s guidance</strong>{' '}
              (propose-then-approve); with view-only access you get the full explanation but
              can&rsquo;t author.
            </>
          )}
        </p>
      </section>

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
        <h2 className="text-lg font-semibold text-heading">Handoffs</h2>
        <p className="mt-2 text-sm">
          Each working phase has a <strong>handoff</strong> — the composed prompt you hand
          to a coding agent to carry that phase out end-to-end (<em>Specify handoff</em> in
          specify, <em>Build handoff</em> in build, <em>Verify handoff</em> in verify).
          A handoff isn&rsquo;t a cross-phase action; it&rsquo;s the lifecycle moment that
          moves the Spec forward, so it pulls together that phase&rsquo;s intent,
          discipline, and gate rubric into one copy-ready prompt. Open one to see exactly
          what gets handed over — and, as an admin, to add org guidance that rides along
          with it.
        </p>
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
          handful of seconds via the std-8 cache-invalidation bus. You can author these
          inline here, or just ask the scaffold assistant to do it for you.
        </p>
      </section>
    </div>
  );
}
