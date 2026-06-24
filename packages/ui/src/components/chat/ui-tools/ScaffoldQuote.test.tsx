// spec-360 issue-5 — the scaffold assistant's verbatim-quote block. The exact
// scaffold prose renders as a distinct <pre>-style artifact (NOT markdown-parsed,
// whitespace preserved), with an optional source caption. UiToolRenderer
// dispatches 'render_scaffold_quote' to this component.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { ScaffoldQuote } from './ScaffoldQuote';
import { UiToolRenderer } from './index';

// ac-6 (implementation): the scaffold mode runs on the existing ChatPanel host —
// these display-only render tools are part of that surface.
const AC = 'mindset-prod/memex-building-itself/specs/spec-360/acs/ac-6';

describe('ScaffoldQuote — verbatim quote block (issue-5, ac-6)', () => {
  it('renders the text verbatim (whitespace preserved, NOT markdown-parsed)', () => {
    tagAc(AC);
    const text = '## Build phase\n- resolve `create_task` **first**';
    const { container } = render(<ScaffoldQuote input={{ text }} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    // The literal markdown markers survive — no heading/bold/code conversion.
    expect(pre!.textContent).toBe(text);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('code')).toBeNull();
    expect(container.querySelector('h2')).toBeNull();
    // whitespace-pre-wrap keeps the newlines + indentation as-is.
    expect(pre!.className).toContain('whitespace-pre-wrap');
  });

  it('renders the source caption only when provided', () => {
    tagAc(AC);
    const { container, rerender } = render(
      <ScaffoldQuote input={{ text: 'verbatim', source: 'build phase guidance' }} />,
    );
    expect(screen.getByText('build phase guidance')).toBeInTheDocument();
    expect(container.querySelector('figcaption')).not.toBeNull();

    rerender(<ScaffoldQuote input={{ text: 'verbatim' }} />);
    expect(container.querySelector('figcaption')).toBeNull();
  });
});

// spec-360 issue-13 — copyable handoff. When the assistant hands off a prompt
// it can't run itself (create a Standard / a new Spec), it sets `copyable: true`,
// which adds a Copy button that writes the verbatim text to the clipboard.
describe('ScaffoldQuote — copyable handoff prompt (issue-13, ac-6)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copyable=true shows the Copy button and writes input.text to the clipboard', async () => {
    tagAc(AC);
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom has no clipboard — stub navigator.clipboard for this test.
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    const PROMPT = 'Open the Standards agent and paste this: capture an AC-per-task rule.';
    render(<ScaffoldQuote input={{ text: PROMPT, source: 'Prompt for the Standards agent', copyable: true }} />);

    const btn = screen.getByTestId('scaffold-quote-copy');
    expect(btn).toHaveTextContent('Copy');
    await userEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    // The label flips to "Copied" after a successful write.
    await waitFor(() => expect(btn).toHaveTextContent('Copied'));
  });

  it('copyable falsy → no Copy button (a plain verbatim quote)', () => {
    tagAc(AC);
    const { rerender } = render(
      <ScaffoldQuote input={{ text: 'verbatim quote', source: 'build phase guidance' }} />,
    );
    expect(screen.queryByTestId('scaffold-quote-copy')).not.toBeInTheDocument();

    rerender(<ScaffoldQuote input={{ text: 'verbatim quote', source: 'x', copyable: false }} />);
    expect(screen.queryByTestId('scaffold-quote-copy')).not.toBeInTheDocument();
  });
});

describe('UiToolRenderer dispatch (issue-5, ac-6)', () => {
  it("dispatches 'render_scaffold_quote' to ScaffoldQuote", () => {
    tagAc(AC);
    const { container } = render(
      <UiToolRenderer
        toolName="render_scaffold_quote"
        toolId="t1"
        input={{ text: 'EXACT-SCAFFOLD-TEXT', source: 'verify gate rubric' }}
        disabled={false}
        onRespond={vi.fn()}
      />,
    );
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('EXACT-SCAFFOLD-TEXT');
    expect(screen.getByText('verify gate rubric')).toBeInTheDocument();
    // It is NOT the unknown-tool fallback.
    expect(container.textContent).not.toContain('Unknown UI tool');
  });
});
