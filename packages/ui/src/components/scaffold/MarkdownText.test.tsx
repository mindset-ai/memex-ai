// spec-343: the raw+formatted markdown renderer keeps syntax visible while
// styling content (ac-2 — the composed prompt is shown legibly, base-vs-yours,
// without converting away the literal prompt string).

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { MarkdownText } from './MarkdownText';

const AC = 'mindset-prod/memex-building-itself/specs/spec-343/acs/ac-2';

describe('MarkdownText — raw markdown with live formatting (ac-2)', () => {
  it('keeps heading markers visible but styles the line as a heading', () => {
    tagAc(AC);
    const { container } = render(<MarkdownText text={'## What to inspect'} />);
    // The literal "##" is preserved in the text…
    expect(container.textContent).toBe('## What to inspect');
    // …and the content is styled as a heading (heading token class present).
    expect(container.querySelector('.text-heading')).not.toBeNull();
  });

  it('keeps ** markers visible and renders the content bold', () => {
    tagAc(AC);
    const { container } = render(<MarkdownText text={'- **proceed** — safe to publish.'} />);
    expect(container.textContent).toContain('**proceed**');
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('**proceed**');
  });

  it('keeps backticks visible and renders inline code monospaced', () => {
    tagAc(AC);
    const { container } = render(<MarkdownText text={'captured as `open` decisions'} />);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('`open`');
    expect(container.textContent).toContain('`open`');
  });

  it('does not mangle snake_case identifiers as italics', () => {
    tagAc(AC);
    const { container } = render(<MarkdownText text={'tools like org_scaffold_additions and create_task'} />);
    expect(container.textContent).toBe('tools like org_scaffold_additions and create_task');
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
  });

  it('preserves blank-line structure and renders fenced code verbatim', () => {
    tagAc(AC);
    const { container } = render(<MarkdownText text={'intro\n\n```\na = 1\n```\nend'} />);
    // The fence markers and code line survive intact.
    expect(container.textContent).toContain('```');
    expect(container.textContent).toContain('a = 1');
  });
});
