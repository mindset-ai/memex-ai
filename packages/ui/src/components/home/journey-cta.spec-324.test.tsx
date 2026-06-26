// spec-324 ac-2 — every custom-component journey step emits home_canvas.cta_clicked
// on its primary interaction. The generic JourneyStepShell steps already record via
// HomeCanvas.handleCta; this proves the bespoke step components fire the same intent
// signal through the onCtaClick prop HomeCanvas wires to trackStepCta.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
const postJourneyEventApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi, postJourneyEventApi }));

const updateProfileApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ updateProfileApi }));

vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    token: 'fake',
    user: { id: 'u-1', name: 'John Doe', email: 'john@example.com' },
    updateSession: vi.fn(),
  }),
}));

import { WelcomeStep } from './WelcomeStep';
import { IdentityStep } from './IdentityStep';
import { ConnectAgentStep } from './ConnectAgentStep';
import { CreateSpecStep } from './CreateSpecStep';
import { CreateFirstSpecStep } from './CreateFirstSpecStep';
import { AgentPromptStep } from './AgentPromptStep';
import { SeeGreenStep } from './SeeGreenStep';

const AC2 = 'mindset-prod/memex-building-itself/specs/spec-324/acs/ac-2';

beforeEach(() => {
  fetchJourneyStateApi.mockReset().mockResolvedValue({ milestones: {} });
  postJourneyEventApi.mockReset();
  updateProfileApi.mockReset().mockResolvedValue({ needsOnboarding: false });
  // jsdom has no clipboard; the copy steps fire onCopy in writeText().then().
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

async function clickCopyWithin(testId: string): Promise<void> {
  const copy = within(screen.getByTestId(testId)).getByText('Copy');
  fireEvent.click(copy);
}

describe('custom journey steps fire onCtaClick on their primary interaction (spec-324 ac-2)', () => {
  it('welcome → "get_started" on the Get started CTA', () => {
    tagAc(AC2);
    const onCtaClick = vi.fn();
    render(<WelcomeStep onNavigate={vi.fn()} onCtaClick={onCtaClick} />);
    fireEvent.click(screen.getByTestId('journey-cta-primary'));
    expect(onCtaClick).toHaveBeenCalledWith('get_started');
  });

  it('identity → "submit_identity" on Continue', async () => {
    tagAc(AC2);
    const onCtaClick = vi.fn();
    render(<IdentityStep onCtaClick={onCtaClick} />);
    fireEvent.click(screen.getByTestId('identity-continue'));
    await waitFor(() => expect(onCtaClick).toHaveBeenCalledWith('submit_identity'));
  });

  it('connect-agent → "copy_install" on copying the setup command', async () => {
    tagAc(AC2);
    const onCtaClick = vi.fn();
    render(<ConnectAgentStep onCtaClick={onCtaClick} />);
    await clickCopyWithin('connect-instructions');
    await waitFor(() => expect(onCtaClick).toHaveBeenCalledWith('copy_install'));
  });

  it('create-first-spec → "copy_create_prompt" on copying the sample prompt', async () => {
    // spec-421 t-3b: the copy_create_prompt CTA moved from CreateSpecStep's Stage-2 prompt
    // to CreateFirstSpecStep's collapsible sample-prompt helper (spec-372 t-10 dec-6 intent preserved).
    const AC421 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;
    tagAc(AC2);
    tagAc(AC421(9)); // copying the sample prompt emits copy_create_prompt
    const onCtaClick = vi.fn();
    render(<CreateFirstSpecStep preview onCtaClick={onCtaClick} />);
    await clickCopyWithin('sample-prompt-helper');
    await waitFor(() => expect(onCtaClick).toHaveBeenCalledWith('copy_create_prompt'));
  });

  it('resolve-decision (agent-prompt) → "copy_prompt" on copying the prompt', async () => {
    tagAc(AC2);
    const onCtaClick = vi.fn();
    render(<AgentPromptStep stepId="resolve-decision" onCtaClick={onCtaClick} />);
    await clickCopyWithin('agent-prompt');
    await waitFor(() => expect(onCtaClick).toHaveBeenCalledWith('copy_prompt'));
  });

  it('see-green → "copy_prompt" on copying the prompt', async () => {
    tagAc(AC2);
    const onCtaClick = vi.fn();
    render(<SeeGreenStep onCtaClick={onCtaClick} />);
    await clickCopyWithin('see-green-prompt');
    await waitFor(() => expect(onCtaClick).toHaveBeenCalledWith('copy_prompt'));
  });
});
