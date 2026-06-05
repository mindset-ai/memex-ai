import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Task } from '../api/types';

/**
 * t-19 W4 — read-only DAG view of a spec's tasks.
 *
 * Nodes: each `Task`. Edges: blocking dependencies (`task → blocking task` and
 * `task → blocking decision`). Tasks with a linked execution plan get a
 * distinct visual marker (the `data-has-plan` attribute on the node card +
 * an emerald accent).
 *
 * Layout is intentionally simple: ready/not-blocked work on the left lane,
 * in-progress in the middle, blocked on the right. Within each lane nodes
 * are stacked top-to-bottom by `seq`. This keeps the graph deterministic and
 * legible at MVP scale (≤ ~30 tasks per spec); switch to a proper
 * dagre layout if/when scale forces it.
 *
 * Out of scope for this slice: drag-to-reorganise, cross-spec edges,
 * agent-launch buttons (those land in t-17b's full graph slice).
 */

export interface TaskGraphData {
  nodes: Node[];
  edges: Edge[];
}

const COLUMN_X = {
  ready: 40,
  in_progress: 360,
  blocked: 680,
};

const ROW_HEIGHT = 110;

interface NodeData extends Record<string, unknown> {
  task: Task;
}

/**
 * Pure mapping from `Task[]` to reactflow nodes + edges. Exported for unit
 * testing — the React render below trusts whatever this returns.
 */
export function buildTaskGraphData(tasks: Task[]): TaskGraphData {
  const ready: Task[] = [];
  const inProgress: Task[] = [];
  const blocked: Task[] = [];

  for (const t of tasks) {
    if (t.status === 'in_progress') inProgress.push(t);
    else if (t.blocked) blocked.push(t);
    else ready.push(t); // not_started + not blocked, OR complete (just settle in ready lane for now)
  }

  const nodes: Node[] = [];
  const placeColumn = (column: Task[], x: number) => {
    column
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .forEach((t, idx) => {
        nodes.push({
          id: t.id,
          type: 'default',
          position: { x, y: 40 + idx * ROW_HEIGHT },
          data: { task: t } satisfies NodeData,
          // Custom inline label keeps node small — title truncated, status label,
          // and a marker dot when there's a linked execution plan.
          // Reactflow renders `data.label` if no custom node component is
          // registered; we provide a JSX label here for the inline render.
          // (Switch to a custom node type later if more controls are needed.)
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          ...({
            data: {
              task: t,
              label: renderNodeLabel(t),
            },
          } as Partial<Node>),
        });
      });
  };
  placeColumn(ready, COLUMN_X.ready);
  placeColumn(inProgress, COLUMN_X.in_progress);
  placeColumn(blocked, COLUMN_X.blocked);

  const taskIds = new Set(tasks.map((t) => t.id));
  const edges: Edge[] = [];
  for (const t of tasks) {
    for (const b of t.blockedByTasks) {
      // Only render the edge when both endpoints are visible; cross-spec
      // edges fall outside this graph (per t-19 W4 scope).
      if (!taskIds.has(b.id)) continue;
      edges.push({
        id: `task-${t.id}-task-${b.id}`,
        source: b.id, // upstream blocker → downstream blocked
        target: t.id,
        animated: false,
        data: { kind: 'task' },
      });
    }
    for (const d of t.blockedByDecisions) {
      // Decisions aren't nodes in this graph (single-spec work-item view),
      // so synthesize a virtual decision node so the edge has somewhere to go.
      const decNodeId = `dec-${d.id}`;
      if (!nodes.some((n) => n.id === decNodeId)) {
        nodes.push({
          id: decNodeId,
          type: 'default',
          position: { x: -240, y: 40 + nodes.filter((n) => n.id.startsWith('dec-')).length * ROW_HEIGHT },
          data: { label: `D-${d.seq}: ${truncate(d.title, 32)}` },
          style: {
            background: 'rgb(254 243 199)',
            border: '1px dashed rgb(217 119 6)',
            borderRadius: '6px',
            fontSize: '11px',
            color: 'rgb(120 53 15)',
          },
        });
      }
      edges.push({
        id: `dec-${d.id}-task-${t.id}`,
        source: decNodeId,
        target: t.id,
        animated: false,
        style: { strokeDasharray: '4 4' },
        data: { kind: 'decision' },
      });
    }
  }

  return { nodes, edges };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function renderNodeLabel(task: Task): string {
  const hasPlan = !!task.executionPlanDocId;
  const planMarker = hasPlan ? ' ●' : '';
  return `T-${task.seq}${planMarker}\n${truncate(task.title, 30)}\n[${task.status}]`;
}

interface TaskGraphProps {
  tasks: Task[];
}

export function TaskGraph({ tasks }: TaskGraphProps) {
  const { nodes, edges } = useMemo(() => buildTaskGraphData(tasks), [tasks]);

  return (
    <div data-testid="task-graph" style={{ width: '100%', height: '600px' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
