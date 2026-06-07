// b-68 t-12 tests. Asserts:
//   - ac-15: rationale is rendered for every kind of node.
//   - ac-18: ONE generic component switches on `kind` (no per-kind file).

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ScaffoldNodeView } from './ScaffoldNodeView';
import { tagAc } from "@memex-ai-ac/vitest";
import type {
  GuidanceBlock,
  PhaseNode,
  PromptBlockNode,
  ScaffoldNode,
  ToolNode,
  TransitionRubric,
} from '@memex/shared';

const phase: PhaseNode = {
  kind: 'phase',
  phase: 'specify',
  intent: 'shape narrative; resolve decisions',
  allowance: { allowed: ['update_section'], blocked: ['create_task'] },
  promptBlockIds: ['role', 'mdx-components'],
  rationale: 'Phase rationale text',
};

const promptBlock: PromptBlockNode = {
  kind: 'prompt_block',
  id: 'role',
  surface: 'react_only',
  text: 'You are an agent.',
  rationale: 'Prompt block rationale text',
};

const tool: ToolNode = {
  kind: 'tool',
  name: 'create_task',
  summary: 'Create a build-phase task.',
  args: '(briefRef, title, description)',
  group: 'build',
  rationale: 'Tool rationale text',
};

const transition: TransitionRubric = {
  kind: 'transition_rubric',
  transition: 'build',
  text: '# specify→build rubric body',
  rationale: 'Transition rationale text',
};

const guidance: GuidanceBlock = {
  kind: 'guidance_block',
  source: 'base',
  target: { phase: 'specify' },
  text: 'Allowed now: x, y, z.',
  enabled: true,
  order: 1,
  rationale: 'Guidance rationale text',
};

const orgGuidance: GuidanceBlock = {
  ...guidance,
  source: 'org',
  orgId: 'org-1',
  authorId: 'user-1',
  createdAt: '2026-05-26T10:00:00Z',
  updatedAt: '2026-05-27T11:00:00Z',
  rationale: 'Org guidance rationale text',
};

describe('ScaffoldNodeView', () => {
  it('renders rationale for every node kind (ac-15)', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-15');
    const allKinds: ScaffoldNode[] = [phase, promptBlock, tool, transition, guidance, orgGuidance];

    const { unmount } = render(
      <div>
        {allKinds.map((node, idx) => (
          <ScaffoldNodeView key={idx} node={node} />
        ))}
      </div>,
    );

    const rationaleEls = screen.getAllByTestId('scaffold-rationale');
    // One rationale block per node.
    expect(rationaleEls).toHaveLength(allKinds.length);
    // Each rationale block prefixes with "Rationale:" and shows distinct text.
    expect(rationaleEls[0]).toHaveTextContent('Phase rationale text');
    expect(rationaleEls[1]).toHaveTextContent('Prompt block rationale text');
    expect(rationaleEls[2]).toHaveTextContent('Tool rationale text');
    expect(rationaleEls[3]).toHaveTextContent('Transition rationale text');
    expect(rationaleEls[4]).toHaveTextContent('Guidance rationale text');
    expect(rationaleEls[5]).toHaveTextContent('Org guidance rationale text');

    unmount();
  });

  it('renders agent-facing text distinct from rationale (ac-15)', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-15');
    render(<ScaffoldNodeView node={promptBlock} />);
    // Agent text body present.
    expect(screen.getByText('You are an agent.')).toBeInTheDocument();
    // Rationale present and distinct.
    const r = screen.getByTestId('scaffold-rationale');
    expect(r).toHaveTextContent('Prompt block rationale text');
    expect(r).not.toHaveTextContent('You are an agent.');
  });

  it('is one component that switches on kind — no per-kind components (ac-18)', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-18');
    const cases: Array<{ node: ScaffoldNode; expectedKind: string }> = [
      { node: phase, expectedKind: 'phase' },
      { node: promptBlock, expectedKind: 'prompt_block' },
      { node: tool, expectedKind: 'tool' },
      { node: transition, expectedKind: 'transition_rubric' },
      { node: guidance, expectedKind: 'guidance_block' },
    ];

    const { unmount } = render(
      <div>
        {cases.map((c, idx) => (
          <ScaffoldNodeView key={idx} node={c.node} />
        ))}
      </div>,
    );

    // Each render is wrapped in the SAME outer component (data-testid identical).
    const outers = screen.getAllByTestId('scaffold-node-view');
    expect(outers).toHaveLength(cases.length);

    // The INNER body uses different `data-kind` markers per kind — proving the
    // single component is dispatching on `kind`, not delegating to N components.
    for (const [i, c] of cases.entries()) {
      const inner = within(outers[i]).getByTestId(`scaffold-rationale`);
      expect(inner).toBeInTheDocument();
      // The body marker preceding the rationale carries the kind discriminator.
      const bodyByKind = outers[i].querySelector(`[data-kind="${c.expectedKind}"]`);
      expect(bodyByKind).toBeTruthy();
    }

    unmount();
  });

  it('renders ToolNode fields: name, summary, args, group, rationale', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-18');
    render(<ScaffoldNodeView node={tool} />);
    expect(screen.getByText('create_task')).toBeInTheDocument();
    expect(screen.getByText('Create a build-phase task.')).toBeInTheDocument();
    expect(screen.getByText('(briefRef, title, description)')).toBeInTheDocument();
    // The group name 'build' is rendered as a separate span sibling of the
    // tool name code element.
    const groupBadges = screen.getAllByText((_, el) =>
      el?.tagName === 'SPAN' && (el?.textContent ?? '').trim() === '· build',
    );
    expect(groupBadges.length).toBeGreaterThan(0);
    expect(screen.getByTestId('scaffold-rationale')).toHaveTextContent('Tool rationale text');
  });

  it('renders org GuidanceBlock author/updatedAt metadata', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-18');
    render(<ScaffoldNodeView node={orgGuidance} />);
    expect(screen.getByText(/user-1/)).toBeInTheDocument();
    expect(screen.getByText(/2026-05-27/)).toBeInTheDocument();
  });

  it('renders PhaseNode allowance and prompt-block links', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-18');
    render(<ScaffoldNodeView node={phase} />);
    expect(screen.getByText(/update_section/)).toBeInTheDocument();
    expect(screen.getByText(/create_task/)).toBeInTheDocument();
    expect(screen.getByText(/role → mdx-components/)).toBeInTheDocument();
  });

  it('renders TransitionRubric prose', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-68/acs/ac-18');
    render(<ScaffoldNodeView node={transition} />);
    expect(screen.getByText(/specify→build rubric body/)).toBeInTheDocument();
  });
});
