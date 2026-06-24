// spec-343 t-3 / t-4: the phase detail.
//
// Selecting a phase on the timeline opens this panel. dec-6 — content is split
// into two labelled groups: "Sent to both agents (MCP + in-app)" (the
// shared-nudge channel: stage guidance + per-tool nudges) and "In-app agent
// only" (React-only prompt blocks: role, MDX components, render_* tools). The
// "Add here" affordance appears only on shared content, never React-only.
// Each tool drills into its own composed nudge circumstance.

import { useMemo } from 'react';
import {
  HANDOFF_BUTTON_BY_PHASE,
  type GuidanceBlock,
  type GuidanceEmphasis,
  type Phase,
  type ScaffoldDataset,
  type Transition,
} from '@memex/shared';
import { CircumstanceDetail } from './CircumstanceDetail';
import { phaseColors } from '../phaseColors';
import { nudgeSegments, orgCountForPhase, stageSegments } from './composition';

const GATE_AFTER: Record<Phase, Transition | null> = {
  draft: 'specify',
  specify: 'build',
  build: 'verify',
  verify: 'done',
  done: null,
};

interface CreateInput {
  target: GuidanceBlock['target'];
  text: string;
  rationale: string;
  emphasis?: GuidanceEmphasis;
  memexId?: string;
}

interface Props {
  phase: Phase;
  dataset: ScaffoldDataset;
  orgBlocks: readonly GuidanceBlock[];
  selectedTool: string | null;
  onSelectTool: (tool: string | null) => void;
  onSelectGate: (transition: Transition) => void;
  onSelectButton: (buttonId: string) => void;
  isAdmin: boolean;
  disabledReason?: string;
  onCreate?: (input: CreateInput) => Promise<void>;
  onToggle?: (id: string, enabled: boolean) => Promise<void>;
  onUpdate?: (id: string, text: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  currentMemexId?: string | null;
  currentMemexLabel?: string;
}

function getPhaseToolNames(dataset: ScaffoldDataset, phase: Phase): string[] {
  const phaseNode = dataset.phases.find((p) => p.phase === phase);
  if (!phaseNode) return dataset.tools.map((t) => t.name);
  const blocked = new Set(phaseNode.allowance.blocked);
  return dataset.tools.map((t) => t.name).filter((n) => !blocked.has(n));
}

export function ScaffoldPhaseDetail({
  phase,
  dataset,
  orgBlocks,
  selectedTool,
  onSelectTool,
  onSelectGate,
  onSelectButton,
  isAdmin,
  disabledReason,
  onCreate,
  onToggle,
  onUpdate,
  onDelete,
  currentMemexId,
  currentMemexLabel,
}: Props) {
  const phaseNode = dataset.phases.find((p) => p.phase === phase);
  const tools = useMemo(() => getPhaseToolNames(dataset, phase), [dataset, phase]);
  const reactOnlyBlocks = useMemo(() => {
    if (!phaseNode) return [];
    const byId = new Map(dataset.promptBlocks.map((b) => [b.id, b]));
    return phaseNode.promptBlockIds
      .map((id) => byId.get(id))
      .filter((b): b is NonNullable<typeof b> => b !== undefined && b.surface === 'react_only');
  }, [dataset, phaseNode]);

  const gate = GATE_AFTER[phase];
  const handoffButtonId = HANDOFF_BUTTON_BY_PHASE[phase];
  const handoffButton = handoffButtonId
    ? dataset.promptButtons.find((b) => b.id === handoffButtonId)
    : undefined;

  const detailProps = {
    isAdmin,
    disabledReason,
    onCreate,
    onToggle,
    onUpdate,
    onDelete,
    currentMemexId,
    currentMemexLabel,
  };

  return (
    <div data-testid={`scaffold-phase-detail-${phase}`} className="space-y-8">
      <header className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${
              phaseColors(phase)?.pill ?? 'border-default text-secondary'
            }`}
          >
            {phase}
          </span>
          {orgCountForPhase(orgBlocks, phase) > 0 ? (
            <span className="text-xs text-amber-500">
              ● {orgCountForPhase(orgBlocks, phase)} from your org
            </span>
          ) : null}
        </div>
        {phaseNode ? <p className="text-sm text-secondary">{phaseNode.intent}</p> : null}
      </header>

      {/* Shared-nudge channel — reaches both agents. */}
      <div data-testid="scaffold-reach-group-both" className="space-y-6">
        <div className="flex items-center gap-2 border-b border-default/60 pb-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/70" aria-hidden="true" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-secondary">Sent to both agents</h2>
          <span className="text-[10px] text-muted">MCP + in-app</span>
        </div>

        {/* Stage guidance — every tool in this phase. */}
        <CircumstanceDetail
          testId="scaffold-circumstance-stage"
          title="Stage guidance"
          subtitle="Rides every tool response during this phase."
          segments={stageSegments(dataset, phase, orgBlocks)}
          addTarget={{ phase }}
          emptyHint="No phase-wide base guidance — add the first."
          {...detailProps}
        />

        {/* Per-tool nudges. */}
        <div data-testid="scaffold-tool-list" className="space-y-2">
          <div className="text-sm font-semibold">Per-tool nudges</div>
          <div className="flex flex-wrap gap-2">
            {tools.map((tool) => {
              const count = orgBlocks.filter((b) => b.target.tool === tool).length;
              const active = selectedTool === tool;
              return (
                <button
                  key={tool}
                  type="button"
                  data-testid={`scaffold-tool-${tool}`}
                  aria-pressed={active}
                  onClick={() => onSelectTool(active ? null : tool)}
                  className={`text-xs font-mono rounded-full px-2.5 py-1 transition-colors ${
                    active ? 'bg-overlay text-primary font-medium' : 'text-secondary hover:text-primary hover:bg-overlay'
                  }`}
                >
                  {tool}
                  {count > 0 ? <span className="ml-1 text-amber-500">●{count}</span> : null}
                </button>
              );
            })}
          </div>

          {selectedTool ? (
            <div className="mt-3">
              <CircumstanceDetail
                testId="scaffold-circumstance-nudge"
                title={`when ${selectedTool} runs during ${phase}`}
                segments={nudgeSegments(dataset, selectedTool, phase, orgBlocks)}
                addTarget={{ tool: selectedTool, phase }}
                emptyHint="No base nudge for this tool here — add the first."
                {...detailProps}
              />
            </div>
          ) : (
            <p className="text-xs text-secondary">Pick a tool to see the exact nudge it emits and add your own.</p>
          )}
        </div>
      </div>

      {/* React-only — reaches the in-app agent only. No authoring (dec-6). */}
      {reactOnlyBlocks.length > 0 ? (
        <div data-testid="scaffold-reach-group-react-only" className="space-y-4">
          <div className="flex items-center gap-2 border-b border-default/60 pb-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400/70" aria-hidden="true" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-secondary">In-app agent only</h2>
            <span className="text-[10px] text-muted">role · MDX · render_* tools</span>
          </div>
          {reactOnlyBlocks.map((b) => (
            <CircumstanceDetail
              key={b.id}
              testId={`scaffold-react-only-${b.id}`}
              title={b.id}
              rationale={b.rationale}
              segments={[{ text: b.text, source: 'base' }]}
              reach="react_only"
              isAdmin={false}
            />
          ))}
        </div>
      ) : null}

      {/* Handoff + outgoing gate. */}
      <div className="flex flex-wrap gap-6 text-sm border-t border-default pt-4">
        {handoffButton ? (
          <div>
            <span className="text-secondary">Handoff: </span>
            <button
              type="button"
              data-testid="scaffold-phase-handoff-link"
              onClick={() => onSelectButton(handoffButton.id)}
              className="text-link underline"
            >
              {handoffButton.label}
            </button>
            <span className="text-secondary"> — copied to enter {phase}</span>
          </div>
        ) : null}
        {gate ? (
          <div>
            <span className="text-secondary">Outgoing gate: </span>
            <button
              type="button"
              data-testid="scaffold-phase-gate-link"
              onClick={() => onSelectGate(gate)}
              className="text-link underline"
            >
              {phase} → {gate}
            </button>
          </div>
        ) : (
          <span className="text-secondary"><code>{phase}</code> is the terminal phase — no forward gate.</span>
        )}
      </div>
    </div>
  );
}
