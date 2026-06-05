// spec-103 t-5: tests for the <PromptButton> primitive.
//
// Interaction model: clicking the button opens a dialog with copy-and-paste
// guidance; the copy happens via the dialog's "Copy prompt" button. Behavioural
// coverage for the resolved decisions: read-only copy of the composed prompt
// (ac-4 / D-1), no analytics (ac-5), missing-node policy (ac-7), single copy
// action (ac-8), icon + label from node metadata (ac-9). Expected copy text is
// computed from the real `verify-spec` node via toButtonPrompt, so these tests
// survive any change to the prompt wording.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_SCAFFOLD, toButtonPrompt } from '@memex/shared';
import { PromptButton } from './PromptButton';
import promptButtonSource from './PromptButton.tsx?raw';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-103';

const CTX = {
  namespace: 'mindset-prod',
  memex: 'memex-building-itself',
  handle: 'spec-103',
  title: 'Prompt Button',
  url: 'https://memex.ai/mindset-prod/memex-building-itself/specs/spec-103',
};

const OPEN_LABEL = 'Show the Verify handoff prompt to copy into a coding agent';

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('PromptButton label (ac-9)', () => {
  it('renders icon + visible label by default, and hides the text with showLabel=false', () => {
    tagAc(`${SPEC}/acs/ac-9`);

    const { rerender } = render(<PromptButton buttonId="verify-spec" context={CTX} />);
    expect(screen.getByText('Verify handoff')).toBeTruthy();
    // label drives the accessible name on the trigger
    expect(screen.getByRole('button', { name: OPEN_LABEL })).toBeTruthy();

    rerender(<PromptButton buttonId="verify-spec" context={CTX} showLabel={false} />);
    expect(screen.queryByText('Verify handoff')).toBeNull();
    // still accessible icon-only
    expect(screen.getByRole('button', { name: OPEN_LABEL })).toBeTruthy();
  });
});

describe('PromptButton opens a dialog (the point of the button)', () => {
  it('clicking the button opens a dialog with copy-and-paste guidance', () => {
    render(<PromptButton buttonId="verify-spec" context={CTX} />);
    fireEvent.click(screen.getByRole('button', { name: OPEN_LABEL }));

    expect(screen.getByRole('dialog', { name: /Verify handoff prompt/ })).toBeTruthy();
    expect(screen.getByText(/paste it into a coding-agent session/i)).toBeTruthy();
  });

  it('shows the prompt read-only — no editable field (D-1)', () => {
    render(<PromptButton buttonId="verify-spec" context={CTX} />);
    fireEvent.click(screen.getByRole('button', { name: OPEN_LABEL }));

    const dialog = screen.getByRole('dialog', { name: /Verify handoff prompt/ });
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });
});

describe('PromptButton copy (ac-4, ac-8)', () => {
  it('copies exactly the toButtonPrompt() output from the dialog (ac-4)', async () => {
    tagAc(`${SPEC}/acs/ac-4`);

    const expected = toButtonPrompt({ dataset: BASE_SCAFFOLD, buttonId: 'verify-spec', context: CTX });
    render(<PromptButton buttonId="verify-spec" context={CTX} />);

    fireEvent.click(screen.getByRole('button', { name: OPEN_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
    // visible confirmation, not a silent write
    await waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeTruthy());
  });

  it('performs exactly one action — copy — with no execute-here control (ac-8)', async () => {
    tagAc(`${SPEC}/acs/ac-8`);

    render(<PromptButton buttonId="verify-spec" context={CTX} />);
    fireEvent.click(screen.getByRole('button', { name: OPEN_LABEL }));
    expect(screen.queryByRole('button', { name: /execute/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });

  it('shows a manual-copy hint when the clipboard write fails', async () => {
    writeText.mockRejectedValueOnce(new Error('blocked'));
    render(<PromptButton buttonId="verify-spec" context={CTX} />);

    fireEvent.click(screen.getByRole('button', { name: OPEN_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});

describe('PromptButton missing-node policy (ac-7)', () => {
  it('throws on a missing PromptButtonNode in dev/test', () => {
    tagAc(`${SPEC}/acs/ac-7`);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<PromptButton buttonId="does-not-exist" context={{}} />)).toThrow(/does-not-exist/);
    spy.mockRestore();
  });

  it('renders null + console.error on a missing node in production', () => {
    tagAc(`${SPEC}/acs/ac-7`);

    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = render(<PromptButton buttonId="does-not-exist" context={{}} />);
    expect(container.firstChild).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('PromptButton sentence form (spec-159 ac-17)', () => {
  const SPEC_159 = 'mindset-prod/memex-building-itself/specs/spec-159';
  const SENTENCE = 'a prompt to hand off to your coding agent to verify this spec.';

  it('renders a "Copy" action followed by the sentence prose (not a labelled button)', () => {
    tagAc(`${SPEC_159}/acs/ac-17`);

    render(<PromptButton buttonId="verify-spec" context={CTX} sentence={SENTENCE} />);

    // The visible affordance is the word "Copy" plus the trailing prose — the
    // legacy "Verify handoff" label is gone in the sentence form.
    expect(screen.getByText('Copy')).toBeTruthy();
    expect(screen.queryByText('Verify handoff')).toBeNull();
    // The full sentence is the accessible name of the action.
    expect(screen.getByRole('button', { name: `Copy ${SENTENCE}` })).toBeTruthy();
  });

  it('"Copy" opens the same handoff dialog and copies exactly toButtonPrompt()', async () => {
    tagAc(`${SPEC_159}/acs/ac-17`);

    const expected = toButtonPrompt({ dataset: BASE_SCAFFOLD, buttonId: 'verify-spec', context: CTX });
    render(<PromptButton buttonId="verify-spec" context={CTX} sentence={SENTENCE} />);

    fireEvent.click(screen.getByRole('button', { name: `Copy ${SENTENCE}` }));
    expect(screen.getByRole('dialog', { name: /Verify handoff prompt/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
  });

  it('shows the manual-copy hint when the clipboard write fails (fallback survives)', async () => {
    writeText.mockRejectedValueOnce(new Error('blocked'));
    render(<PromptButton buttonId="verify-spec" context={CTX} sentence={SENTENCE} />);

    fireEvent.click(screen.getByRole('button', { name: `Copy ${SENTENCE}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});

describe('PromptButton has no analytics (ac-5)', () => {
  it('introduces no analytics dependency or telemetry in source', () => {
    tagAc(`${SPEC}/acs/ac-5`);

    // No analytics SDK is imported.
    const imports = promptButtonSource
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');
    expect(imports).not.toMatch(/posthog|mixpanel|segment|amplitude|analytics/i);
    // No telemetry call sites (posthog.capture(...), analytics.track(...), etc.).
    expect(promptButtonSource).not.toMatch(/\b(?:posthog|analytics)\s*\./i);
    expect(promptButtonSource).not.toMatch(/\.(?:capture|track)\s*\(/);
  });
});
