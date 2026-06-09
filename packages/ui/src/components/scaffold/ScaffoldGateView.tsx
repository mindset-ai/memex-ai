// b-68 t-13: gate pane (per s-7).
//
// Renders:
//   1. The base TransitionRubric text.
//   2. The deterministic fact-sheet SHAPE (not values — values are computed
//      per-Spec at runtime by `spec-readiness.ts`).
//   3. Org checks (`target.transition`) for this transition.
//   4. Live preview of the composed rubric (`toRubric`).

import { useMemo } from 'react';
import {
  toRubric,
  type GuidanceBlock,
  type ScaffoldDataset,
  type Transition,
} from '@memex/shared';
import { ScaffoldNodeView } from './ScaffoldNodeView';
import { ScaffoldAdditionEditor } from './ScaffoldAdditionEditor';

interface Props {
  transition: Transition;
  dataset: ScaffoldDataset;
  orgBlocks: readonly GuidanceBlock[];
  isAdmin: boolean;
  onCreateAddition?: (input: {
    target: GuidanceBlock['target'];
    text: string;
    rationale: string;
    emphasis?: GuidanceBlock['emphasis'];
    memexId?: string;
  }) => Promise<void>;
  onToggleAddition?: (id: string, enabled: boolean) => Promise<void>;
  // spec-193 t-5: the memex the Inspect page is anchored to (for the Scope control).
  currentMemexId?: string | null;
  currentMemexLabel?: string;
}

// What the deterministic fact sheet structure looks like — the SHAPE, not the
// values. Values are computed per-Spec at runtime by `spec-readiness.ts`.
// This list is illustrative; the canonical source is in
// packages/shared/src/spec-readiness.ts.
const FACT_SHEET_SHAPE: { name: string; explainer: string }[] = [
  { name: 'open decisions', explainer: 'decisions not yet `resolved` or `rejected`.' },
  { name: 'candidate decisions', explainer: 'pending agent-extracted candidates.' },
  { name: 'incomplete tasks', explainer: 'tasks not in a terminal status.' },
  { name: 'resolved-decision AC coverage', explainer: 'resolved decisions with no implementation ACs.' },
  { name: 'open drift comments', explainer: 'drift / plan_revision comments still open.' },
  { name: 'narrative staleness', explainer: 'time since narrative sections last edited vs resolved decisions.' },
];

export function ScaffoldGateView({
  transition,
  dataset,
  orgBlocks,
  isAdmin,
  onCreateAddition,
  onToggleAddition,
  currentMemexId,
  currentMemexLabel,
}: Props) {
  const baseRubric = dataset.transitions.find((t) => t.transition === transition);

  const orgChecks = useMemo(
    () =>
      orgBlocks.filter(
        (g) =>
          g.target.transition === transition &&
          g.target.phase === undefined &&
          g.target.tool === undefined,
      ),
    [orgBlocks, transition],
  );

  const composed = useMemo(
    () => toRubric({ dataset, transition, orgBlocks }),
    [dataset, transition, orgBlocks],
  );

  return (
    <div data-testid={`scaffold-gate-view-${transition}`} className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-heading">
          Gate: →<code>{transition}</code>
        </h1>
        <p className="text-sm text-secondary mt-1">
          Composed rubric the agent walks at this forward transition. The deterministic
          fact sheet below is shape-only; values are computed per-Spec at runtime.
        </p>
      </header>

      <section data-testid="scaffold-gate-base-rubric">
        <h2 className="text-lg font-semibold text-heading">Base rubric</h2>
        {baseRubric ? (
          <div className="mt-2">
            <ScaffoldNodeView node={baseRubric} />
          </div>
        ) : (
          <p className="text-sm text-secondary">(no base rubric defined)</p>
        )}
      </section>

      <section data-testid="scaffold-gate-fact-sheet">
        <h2 className="text-lg font-semibold text-heading">Deterministic fact-sheet shape</h2>
        <p className="text-sm text-secondary mb-3">
          The agent receives these {FACT_SHEET_SHAPE.length} facts alongside the rubric
          when called for a Spec. The values are computed at request time; here we show
          what each check measures.
        </p>
        <ul className="text-sm space-y-1 list-disc list-inside">
          {FACT_SHEET_SHAPE.map((f) => (
            <li key={f.name}>
              <span className="font-semibold">{f.name}</span> — {f.explainer}
            </li>
          ))}
        </ul>
      </section>

      <section data-testid="scaffold-gate-org-checks">
        <h2 className="text-lg font-semibold text-heading">Org checks</h2>
        {orgChecks.length === 0 ? (
          <p className="text-sm text-secondary">(none)</p>
        ) : (
          <div className="space-y-2">
            {orgChecks.map((g) => {
              const id = (g as GuidanceBlock & { id?: string }).id;
              return (
                <div key={id ?? `${g.order}-${g.text.slice(0, 24)}`} className="space-y-1">
                  <ScaffoldNodeView node={g} />
                  {isAdmin && id && onToggleAddition ? (
                    <label className="text-xs text-secondary inline-flex items-center gap-2 ml-3">
                      <input
                        type="checkbox"
                        checked={g.enabled}
                        onChange={(e) => {
                          void onToggleAddition(id, e.target.checked);
                        }}
                        data-testid={`scaffold-org-toggle-${id}`}
                      />
                      <span>Enabled</span>
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {isAdmin && onCreateAddition ? (
          <ScaffoldAdditionEditor
            initialTarget={{ transition }}
            onSubmit={onCreateAddition}
            label="Add gate check"
            currentMemexId={currentMemexId}
            currentMemexLabel={currentMemexLabel}
          />
        ) : null}
      </section>

      <section data-testid="scaffold-gate-live-preview">
        <h2 className="text-lg font-semibold text-heading">Live preview</h2>
        <p className="text-sm text-secondary mb-3">
          The composed rubric the agent receives — base prose + enabled Org checks.
        </p>
        <pre
          data-testid="scaffold-gate-live-preview-text"
          className="text-xs whitespace-pre-wrap bg-muted/30 p-3 rounded border border-default"
        >
          {composed || '(empty)'}
        </pre>
      </section>
    </div>
  );
}
