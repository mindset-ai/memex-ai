// spec-103 t-7: Prompt Button pane in the Scaffold Inspect UI.
//
// Renders a single PromptButtonNode (spec-103 D-7):
//   1. What it is (rationale) + where it appears (surfaces) + handle.
//   2. The base prompt template (with `{token}` placeholders).
//   3. Org additions targeting this button (`target.button`).
//   4. Live preview of the composed prompt (`toButtonPrompt`).
//
// The admin "+ Add guidance" authoring affordance + per-addition "Enabled"
// toggle mirror the GATE pane (ScaffoldGateView): an Org admin can append
// guidance to a Prompt Button via `target.button` (spec-103 t-7).

import { useMemo } from 'react';
import { toButtonPrompt, type GuidanceBlock, type ScaffoldDataset } from '@memex/shared';
import { ScaffoldAdditionEditor } from './ScaffoldAdditionEditor';

interface Props {
  buttonId: string;
  dataset: ScaffoldDataset;
  orgBlocks: readonly GuidanceBlock[];
  isAdmin?: boolean;
  onCreateAddition?: (input: {
    target: GuidanceBlock['target'];
    text: string;
    rationale: string;
    emphasis?: GuidanceBlock['emphasis'];
  }) => Promise<void>;
  onToggleAddition?: (id: string, enabled: boolean) => Promise<void>;
}

const PRE_CLASS =
  'text-xs whitespace-pre-wrap break-words bg-muted/30 p-3 rounded border border-default';

export function ScaffoldButtonView({
  buttonId,
  dataset,
  orgBlocks,
  isAdmin,
  onCreateAddition,
  onToggleAddition,
}: Props) {
  const button = dataset.promptButtons.find((b) => b.id === buttonId);

  const orgAppends = useMemo(
    () =>
      orgBlocks.filter(
        (g) =>
          g.target.button === buttonId &&
          g.target.phase === undefined &&
          g.target.tool === undefined &&
          g.target.transition === undefined,
      ),
    [orgBlocks, buttonId],
  );

  const composed = useMemo(
    () => (button ? toButtonPrompt({ dataset, buttonId, context: {}, orgBlocks }) ?? '' : ''),
    [dataset, buttonId, orgBlocks, button],
  );

  if (!button) {
    return (
      <p className="text-sm text-secondary">
        (no prompt button “{buttonId}”)
      </p>
    );
  }

  return (
    <div data-testid={`scaffold-button-view-${buttonId}`} className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-heading">Prompt Button: {button.label}</h1>
        <p className="text-sm text-secondary mt-1">
          A UI button that copies this prompt to the clipboard to hand work off to a coding
          agent. Surfaces: {button.surfaces.length ? button.surfaces.join(', ') : '—'} · Handle:{' '}
          <code>{button.id}</code>
        </p>
      </header>

      <section>
        <h2 className="text-lg font-semibold text-heading">What this is</h2>
        <p className="text-sm text-secondary mt-1">{button.rationale}</p>
      </section>

      <section data-testid="scaffold-button-base-prompt">
        <h2 className="text-lg font-semibold text-heading">Base prompt</h2>
        <p className="text-sm text-secondary mb-2">
          <code>{'{token}'}</code> placeholders are filled from the surface’s context when the
          button is clicked.
        </p>
        <pre className={PRE_CLASS}>{button.text}</pre>
      </section>

      <section data-testid="scaffold-button-org-additions">
        <h2 className="text-lg font-semibold text-heading">Org additions</h2>
        {orgAppends.length === 0 ? (
          <p className="text-sm text-secondary">
            (none) — your Org hasn’t appended any guidance to this button.
          </p>
        ) : (
          <div className="space-y-2">
            {orgAppends.map((g) => {
              const id = (g as GuidanceBlock & { id?: string }).id;
              return (
                <div key={id ?? `${g.order}-${g.text.slice(0, 24)}`} className="space-y-1">
                  <pre className={PRE_CLASS}>{g.text}</pre>
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
            initialTarget={{ button: buttonId }}
            onSubmit={onCreateAddition}
            label="Add button guidance"
          />
        ) : null}
      </section>

      <section data-testid="scaffold-button-live-preview">
        <h2 className="text-lg font-semibold text-heading">Live preview</h2>
        <p className="text-sm text-secondary mb-3">
          The composed prompt — base + enabled Org additions. Placeholders are shown unfilled
          (a real click fills them from context).
        </p>
        <pre data-testid="scaffold-button-live-preview-text" className={PRE_CLASS}>
          {composed || '(empty)'}
        </pre>
      </section>
    </div>
  );
}
