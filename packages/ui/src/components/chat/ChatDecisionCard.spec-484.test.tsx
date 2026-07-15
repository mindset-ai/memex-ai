import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-484 t-2 / dec-2 — the ChatDecisionCard resolution line is a single-line
// truncated PREVIEW. Like DocOutline, it must STAY plain text: markdown-y
// resolution content reads as literal characters on one clamped line, never
// rendered (ac-15).

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

const MARKDOWNY = '**bold** resolution with `code`';

vi.mock('../ChatContext', () => ({
  useChat: () => ({
    doc: {
      decisions: [
        {
          id: 'x',
          seq: 1,
          title: 'A decision',
          status: 'resolved',
          resolution: MARKDOWNY,
        },
      ],
    },
  }),
}));

import { ChatDecisionCard } from './ChatDecisionCard';

describe('spec-484: ChatDecisionCard preview stays plain (ac-15)', () => {
  it('ac-15: markdown-y resolution renders as literal text, clamped, not as markdown', () => {
    tagAc(AC(15));
    const { container } = render(<ChatDecisionCard id="dec-1" />);
    // No markdown rendered.
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('code')).toBeNull();
    // Verbatim characters live inside the single-line truncated preview.
    const clamped = container.querySelector('.truncate');
    expect(clamped?.textContent).toBe(MARKDOWNY);
  });
});
