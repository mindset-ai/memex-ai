// b-68 t-13: phase pane.
//
// Per s-7 of the spec, the phase view renders five sub-panels:
//   1. System prompt (React-only) — list of `react_only` PromptBlockNodes.
//   2. Tool nudges (this phase) — composed nudge per tool in the phase.
//   3. Stage guidance — phase-targeted GuidanceBlocks (`target.phase`).
//   4. Outgoing gate — link to the gate pane.
//   5. Live preview — exact composed text the agent receives for a selected
//      tool in this phase (base + enabled Org via `toNudge`).
//
// `toNudge` is the same projection both runtimes call, so the live preview
// here is the canonical answer — ac-4.

import { useMemo, useState } from 'react';
import { toNudge, type Phase, type ScaffoldDataset, type GuidanceBlock } from '@memex/shared';
import { ScaffoldNodeView } from './ScaffoldNodeView';
import { ScaffoldAdditionEditor } from './ScaffoldAdditionEditor';

interface Props {
  phase: Phase;
  dataset: ScaffoldDataset;
  orgBlocks: readonly GuidanceBlock[];
  /** Triggered when the user clicks the "outgoing gate" link. */
  onSelectGate?: () => void;
  /** Admin-only authoring: callbacks for the inline editor. */
  isAdmin: boolean;
  onCreateAddition?: (input: {
    target: GuidanceBlock['target'];
    text: string;
    rationale: string;
    emphasis?: GuidanceBlock['emphasis'];
  }) => Promise<void>;
  onToggleAddition?: (id: string, enabled: boolean) => Promise<void>;
}

const TRANSITION_FOR_PHASE: Record<Phase, string | null> = {
  draft: 'specify',
  specify: 'build',
  build: 'verify',
  verify: 'done',
  done: null,
};

function getPhaseToolNames(dataset: ScaffoldDataset, phase: Phase): string[] {
  const phaseNode = dataset.phases.find((p) => p.phase === phase);
  if (!phaseNode) return dataset.tools.map((t) => t.name);
  const blocked = new Set(phaseNode.allowance.blocked);
  return dataset.tools.map((t) => t.name).filter((n) => !blocked.has(n));
}

export function ScaffoldPhaseView({
  phase,
  dataset,
  orgBlocks,
  onSelectGate,
  isAdmin,
  onCreateAddition,
  onToggleAddition,
}: Props) {
  const phaseNode = dataset.phases.find((p) => p.phase === phase);
  const reactOnlyBlocks = useMemo(() => {
    if (!phaseNode) return [];
    const byId = new Map(dataset.promptBlocks.map((b) => [b.id, b]));
    return phaseNode.promptBlockIds
      .map((id) => byId.get(id))
      .filter((b): b is NonNullable<typeof b> => b !== undefined && b.surface === 'react_only');
  }, [dataset, phaseNode]);

  const phaseTools = useMemo(() => getPhaseToolNames(dataset, phase), [dataset, phase]);

  const stageGuidanceBase = useMemo(
    () =>
      dataset.baseGuidance.filter(
        (g) => g.target.phase === phase && g.target.tool === undefined && g.target.transition === undefined,
      ),
    [dataset, phase],
  );
  const stageGuidanceOrg = useMemo(
    () =>
      orgBlocks.filter(
        (g) => g.target.phase === phase && g.target.tool === undefined && g.target.transition === undefined,
      ),
    [orgBlocks, phase],
  );

  const transition = TRANSITION_FOR_PHASE[phase];

  // Live preview: pick a tool, render the composed nudge through `toNudge`.
  const [previewTool, setPreviewTool] = useState<string>(phaseTools[0] ?? '');
  const livePreview = useMemo(() => {
    if (!previewTool) return '';
    return toNudge({ dataset, tool: previewTool, phase, orgBlocks });
  }, [dataset, phase, previewTool, orgBlocks]);

  return (
    <div data-testid={`scaffold-phase-view-${phase}`} className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-heading">
          Phase: <code>{phase}</code>
        </h1>
        {phaseNode ? (
          <p className="text-sm text-secondary mt-1">{phaseNode.intent}</p>
        ) : null}
      </header>

      {/* 1. System prompt (React-only) */}
      <section data-testid="scaffold-phase-system-prompt">
        <h2 className="text-lg font-semibold text-heading">System prompt (React-only)</h2>
        <p className="text-sm text-secondary mb-3">
          These blocks compose the React-embedded agent's system prompt. The MCP agent
          receives them via the shared nudge channel only when their surface is{' '}
          <code>shared_nudge</code>.
        </p>
        {reactOnlyBlocks.length === 0 ? (
          <p className="text-sm text-secondary">(none)</p>
        ) : (
          <div className="space-y-2">
            {reactOnlyBlocks.map((b) => (
              <ScaffoldNodeView key={b.id} node={b} />
            ))}
          </div>
        )}
      </section>

      {/* 2. Tool nudges (this phase) */}
      <section data-testid="scaffold-phase-tool-nudges">
        <h2 className="text-lg font-semibold text-heading">Tool nudges (this phase)</h2>
        <p className="text-sm text-secondary mb-3">
          For each tool active in this phase, the composed nudge appended to the tool
          response. Computed by <code>toNudge</code>, the same projection both runtimes
          call.
        </p>
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm">{phaseTools.length} tools</summary>
          <div className="mt-3 space-y-3">
            {phaseTools.map((toolName) => {
              const text = toNudge({ dataset, tool: toolName, phase, orgBlocks });
              return (
                <div key={toolName} className="rounded border border-default p-3">
                  <div className="text-sm font-mono font-semibold">{toolName}</div>
                  <pre className="text-xs whitespace-pre-wrap bg-muted/30 p-2 rounded mt-2">{text || '(empty)'}</pre>
                </div>
              );
            })}
          </div>
        </details>
      </section>

      {/* 3. Stage guidance */}
      <section data-testid="scaffold-phase-stage-guidance">
        <h2 className="text-lg font-semibold text-heading">Stage guidance</h2>
        <p className="text-sm text-secondary mb-3">
          Phase-targeted <code>GuidanceBlock</code>s. Apply to every tool in this phase
          (a target with only <code>phase</code> set and no <code>tool</code>).
        </p>
        {stageGuidanceBase.length === 0 && stageGuidanceOrg.length === 0 ? (
          <p className="text-sm text-secondary">(none)</p>
        ) : (
          <div className="space-y-2">
            {stageGuidanceBase.map((g, i) => (
              <ScaffoldNodeView key={`base-${i}`} node={g} />
            ))}
            {stageGuidanceOrg.map((g) => (
              <OrgBlockWithControls
                key={(g as GuidanceBlock & { id?: string }).id ?? `${g.order}-${g.text.slice(0, 24)}`}
                block={g}
                isAdmin={isAdmin}
                onToggle={onToggleAddition}
              />
            ))}
          </div>
        )}
        {isAdmin && onCreateAddition ? (
          <ScaffoldAdditionEditor
            initialTarget={{ phase }}
            onSubmit={onCreateAddition}
            label="Add stage guidance"
          />
        ) : null}
      </section>

      {/* 4. Outgoing gate */}
      <section data-testid="scaffold-phase-outgoing-gate">
        <h2 className="text-lg font-semibold text-heading">Outgoing gate</h2>
        {transition ? (
          <p className="text-sm">
            Forward transition:{' '}
            <button
              type="button"
              className="text-link underline"
              onClick={onSelectGate}
              data-testid="scaffold-phase-gate-link"
            >
              →{transition}
            </button>
          </p>
        ) : (
          <p className="text-sm text-secondary">
            No forward gate — <code>{phase}</code> is the terminal phase.
          </p>
        )}
      </section>

      {/* 5. Live preview */}
      <section data-testid="scaffold-phase-live-preview">
        <h2 className="text-lg font-semibold text-heading">Live preview</h2>
        <p className="text-sm text-secondary mb-3">
          The exact composed nudge text the agent receives for the selected tool in this
          phase. Base content + enabled Org additions, in order — identical to what
          ships at runtime.
        </p>
        <div className="mb-3">
          <label className="text-sm mr-2" htmlFor={`preview-tool-${phase}`}>
            Tool:
          </label>
          <select
            id={`preview-tool-${phase}`}
            data-testid="scaffold-phase-preview-tool-select"
            value={previewTool}
            onChange={(e) => setPreviewTool(e.target.value)}
            className="text-sm border rounded px-2 py-1"
          >
            {phaseTools.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <pre
          data-testid="scaffold-phase-live-preview-text"
          className="text-xs whitespace-pre-wrap bg-muted/30 p-3 rounded border border-default"
        >
          {livePreview || '(empty)'}
        </pre>
      </section>
    </div>
  );
}

// Org block row with an inline enabled toggle. Admin-only.
function OrgBlockWithControls({
  block,
  isAdmin,
  onToggle,
}: {
  block: GuidanceBlock;
  isAdmin: boolean;
  onToggle?: (id: string, enabled: boolean) => Promise<void>;
}) {
  const id = (block as GuidanceBlock & { id?: string }).id;
  return (
    <div className="space-y-1">
      <ScaffoldNodeView node={block} />
      {isAdmin && id && onToggle ? (
        <label className="text-xs text-secondary inline-flex items-center gap-2 ml-3">
          <input
            type="checkbox"
            checked={block.enabled}
            onChange={(e) => {
              void onToggle(id, e.target.checked);
            }}
            data-testid={`scaffold-org-toggle-${id}`}
          />
          <span>Enabled</span>
        </label>
      ) : null}
    </div>
  );
}
