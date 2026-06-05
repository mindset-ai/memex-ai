// spec-103 t-7 tests. Asserts the admin authoring affordance on the Prompt
// Button pane:
//   - ac-12: each PromptButtonNode appears in the Inspect/Extend UI with its
//     base text + (admin-only) "+ Add button guidance" affordance.
//   - the affordance is hidden for non-admins.
//   - the base prompt text always renders.

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ScaffoldButtonView } from './ScaffoldButtonView';
import { tagAc } from '@memex-ai-ac/vitest';
import type { PromptButtonNode, ScaffoldDataset } from '@memex/shared';

const button: PromptButtonNode = {
  kind: 'prompt_button',
  id: 'handoff-to-agent',
  label: 'Hand off to coding agent',
  text: 'Implement Spec {specRef} on branch {branch}.',
  surfaces: ['spec_detail'],
  rationale: 'Lets a human hand a Spec to a coding agent in one click.',
};

const dataset: ScaffoldDataset = {
  phases: [],
  promptBlocks: [],
  tools: [],
  transitions: [],
  baseGuidance: [],
  promptButtons: [button],
};

async function noopCreate(): Promise<void> {}
async function noopToggle(): Promise<void> {}

describe('ScaffoldButtonView', () => {
  it('renders the base prompt text for the PromptButtonNode', () => {
    render(<ScaffoldButtonView buttonId={button.id} dataset={dataset} orgBlocks={[]} />);
    const basePrompt = screen.getByTestId('scaffold-button-base-prompt');
    expect(
      within(basePrompt).getByText('Implement Spec {specRef} on branch {branch}.'),
    ).toBeInTheDocument();
  });

  it('shows the "+ Add button guidance" affordance to admins (ac-12)', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-103/acs/ac-12');
    render(
      <ScaffoldButtonView
        buttonId={button.id}
        dataset={dataset}
        orgBlocks={[]}
        isAdmin
        onCreateAddition={noopCreate}
        onToggleAddition={noopToggle}
      />,
    );
    const trigger = screen.getByTestId('scaffold-add-guidance-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('Add button guidance');
    // Base prompt still renders.
    const basePrompt = screen.getByTestId('scaffold-button-base-prompt');
    expect(
      within(basePrompt).getByText('Implement Spec {specRef} on branch {branch}.'),
    ).toBeInTheDocument();
  });

  it('hides the authoring affordance for non-admins', () => {
    render(
      <ScaffoldButtonView
        buttonId={button.id}
        dataset={dataset}
        orgBlocks={[]}
        isAdmin={false}
        onCreateAddition={noopCreate}
        onToggleAddition={noopToggle}
      />,
    );
    expect(screen.queryByTestId('scaffold-add-guidance-trigger')).not.toBeInTheDocument();
  });
});
