// b-68 t-12: generic <ScaffoldNodeView> — one component that switches on
// `kind` and renders the matching fields. Per b-68 ac-18 there is NO
// per-kind component file; this single switch is the contract. Per ac-15
// every render path surfaces `rationale` distinct from the agent-facing
// `text`.
//
// Visual polish is out of scope (per t-12). The styling is plain Tailwind
// with semantic dividers between the agent-facing block and the rationale
// block. Inline `data-kind` attributes give tests a stable hook.

import type {
  GuidanceBlock,
  PhaseNode,
  PromptBlockNode,
  ScaffoldNode,
  ToolNode,
  TransitionRubric,
} from '@memex/shared';

function formatTarget(target: GuidanceBlock['target']): string {
  const parts: string[] = [];
  if (target.phase) parts.push(`phase:${target.phase}`);
  if (target.tool) parts.push(`tool:${target.tool}`);
  if (target.transition) parts.push(`transition:→${target.transition}`);
  return parts.length === 0 ? 'global (every tool, every phase)' : parts.join(' · ');
}

function RationaleBlock({ rationale }: { rationale: string }) {
  return (
    <div
      data-testid="scaffold-rationale"
      className="mt-2 border-l-2 border-amber-300 pl-3 py-1 text-xs text-secondary italic"
    >
      <span className="font-semibold mr-1">Rationale:</span>
      {rationale}
    </div>
  );
}

function PhaseNodeBody({ node }: { node: PhaseNode }) {
  return (
    <div data-kind="phase" className="space-y-1">
      <div className="text-sm">
        <span className="font-semibold">Phase:</span> <code>{node.phase}</code>
      </div>
      <div className="text-sm">
        <span className="font-semibold">Intent:</span> {node.intent}
      </div>
      <div className="text-xs text-secondary">
        <span className="font-semibold">Allowed:</span>{' '}
        {node.allowance.allowed.length === 0 ? '(none)' : node.allowance.allowed.join(', ')}
        {' · '}
        <span className="font-semibold">Blocked:</span>{' '}
        {node.allowance.blocked.length === 0 ? '(none)' : node.allowance.blocked.join(', ')}
      </div>
      <div className="text-xs text-secondary">
        <span className="font-semibold">Prompt blocks:</span>{' '}
        {node.promptBlockIds.length === 0 ? '(none)' : node.promptBlockIds.join(' → ')}
      </div>
    </div>
  );
}

function PromptBlockNodeBody({ node }: { node: PromptBlockNode }) {
  return (
    <div data-kind="prompt_block" className="space-y-1">
      <div className="text-xs text-secondary">
        <code className="font-mono">{node.id}</code> · surface:{' '}
        <code>{node.surface}</code>
      </div>
      <pre className="text-xs whitespace-pre-wrap bg-muted/30 p-2 rounded">{node.text}</pre>
    </div>
  );
}

function ToolNodeBody({ node }: { node: ToolNode }) {
  return (
    <div data-kind="tool" className="space-y-1">
      <div className="text-sm">
        <code className="font-mono font-semibold">{node.name}</code>
        {node.group ? <span className="text-xs text-secondary"> · {node.group}</span> : null}
      </div>
      <div className="text-sm text-secondary">{node.summary}</div>
      {node.args ? (
        <div className="text-xs text-secondary">
          <span className="font-semibold">Args:</span> <code>{node.args}</code>
        </div>
      ) : null}
    </div>
  );
}

function TransitionRubricBody({ node }: { node: TransitionRubric }) {
  return (
    <div data-kind="transition_rubric" className="space-y-1">
      <div className="text-sm">
        <span className="font-semibold">Transition:</span> →<code>{node.transition}</code>
      </div>
      <pre className="text-xs whitespace-pre-wrap bg-muted/30 p-2 rounded">{node.text}</pre>
    </div>
  );
}

function GuidanceBlockBody({ node }: { node: GuidanceBlock }) {
  return (
    <div data-kind="guidance_block" className="space-y-1">
      <div className="text-xs text-secondary">
        <span className="font-semibold">Source:</span> <code>{node.source}</code> ·{' '}
        <span className="font-semibold">Target:</span> {formatTarget(node.target)} ·{' '}
        <span className="font-semibold">Order:</span> {node.order} ·{' '}
        <span className="font-semibold">Enabled:</span> {node.enabled ? 'yes' : 'no'}
        {node.emphasis ? (
          <>
            {' '}· <span className="font-semibold">Emphasis:</span> <code>{node.emphasis}</code>
          </>
        ) : null}
      </div>
      <pre className="text-xs whitespace-pre-wrap bg-muted/30 p-2 rounded">{node.text}</pre>
      {node.source === 'org' && (node.authorId || node.updatedAt) ? (
        <div className="text-xs text-secondary">
          {node.authorId ? (
            <>
              <span className="font-semibold">Author:</span> {node.authorId}
            </>
          ) : null}
          {node.authorId && node.updatedAt ? ' · ' : ''}
          {node.updatedAt ? (
            <>
              <span className="font-semibold">Updated:</span> {node.updatedAt}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  node: ScaffoldNode;
}

/**
 * Generic node renderer. Single component, switches on `kind`. There is no
 * per-kind component file (per b-68 ac-18 / dec-7).
 */
export function ScaffoldNodeView({ node }: Props) {
  let body: React.ReactNode;
  switch (node.kind) {
    case 'phase':
      body = <PhaseNodeBody node={node} />;
      break;
    case 'prompt_block':
      body = <PromptBlockNodeBody node={node} />;
      break;
    case 'tool':
      body = <ToolNodeBody node={node} />;
      break;
    case 'transition_rubric':
      body = <TransitionRubricBody node={node} />;
      break;
    case 'guidance_block':
      body = <GuidanceBlockBody node={node} />;
      break;
    case 'prompt_button':
      // Prompt Buttons render via ScaffoldButtonView, not this generic node view.
      body = null;
      break;
    default: {
      // Exhaustiveness check — if a new kind is added to the union without a
      // case here, TypeScript flags it as unreachable.
      const _never: never = node;
      void _never;
      body = null;
    }
  }
  return (
    <div
      data-testid="scaffold-node-view"
      data-node-kind={node.kind}
      className="rounded border border-default p-3"
    >
      {body}
      <RationaleBlock rationale={node.rationale} />
    </div>
  );
}
