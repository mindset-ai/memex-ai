// spec-242 t-1 — the reusable Specky text-dialogue surface (dec-1, dec-3).
//
// Proves: the card is NON-modal (no scrim, no dialog role, board content stays
// reachable — ac-7), the pages[] model pages with Next and ends with Close
// (ac-8), at most two actions render with the primary/quiet treatment (dec-1),
// and the card renders no second Specky (dec-3 / ac-12 — the VoiceLayer avatar
// is the face, and it renders independently of this surface).

import { describe, it, expect, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { SpeckyDialogue, type SpeckyDialoguePage } from './SpeckyDialogue';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-242/acs/ac-${n}`;

const twoPages: SpeckyDialoguePage[] = [
  { key: 'one', heading: 'Page one', body: 'First body' },
  { key: 'two', heading: 'Page two', body: 'Second body' },
];

describe('SpeckyDialogue surface (spec-242 dec-1)', () => {
  it('renders a non-modal docked card: no scrim, no dialog role, content behind stays reachable (ac-7)', () => {
    const { container } = render(
      <>
        <button type="button" data-testid="board-button">
          board
        </button>
        <SpeckyDialogue pages={twoPages} onClose={() => {}} />
      </>,
    );

    const card = screen.getByTestId('specky-dialogue');
    // Docked above the VoiceLayer avatar anchor, fixed — not centered, not portal'd.
    expect(card.className).toContain('fixed');
    expect(card.className).toContain('bottom-20');
    expect(card.className).toContain('right-6');
    // Non-modal: complementary landmark, never a dialog, and NO scrim element —
    // nothing covers the viewport, so the board behind stays interactive.
    expect(card).toHaveAttribute('role', 'complementary');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('[class*="inset-0"]')).toBeNull();
    // The board content is still reachable and clickable.
    const boardButton = screen.getByTestId('board-button');
    const clicked = vi.fn();
    boardButton.addEventListener('click', clicked);
    fireEvent.click(boardButton);
    expect(clicked).toHaveBeenCalledTimes(1);

    tagAc(AC(7));
    tagAc(AC(2)); // scope: the reusable non-modal Specky dialogue surface exists
  });

  it('pages with Next on non-final pages and Close on the final page, which fires onClose (ac-8)', () => {
    const onClose = vi.fn();
    const onPageChange = vi.fn();
    render(<SpeckyDialogue pages={twoPages} onClose={onClose} onPageChange={onPageChange} />);

    // Page one: footer reads Next, not Close.
    expect(screen.getByText('Page one')).toBeInTheDocument();
    const footer = screen.getByTestId('specky-dialogue-footer');
    expect(footer).toHaveTextContent('Next');

    // Next advances — the sequence does not end.
    fireEvent.click(footer);
    expect(onClose).not.toHaveBeenCalled();
    expect(onPageChange).toHaveBeenCalledWith(1);
    expect(screen.getByText('Page two')).toBeInTheDocument();

    // Final page: footer reads Close and ends the sequence.
    expect(screen.getByTestId('specky-dialogue-footer')).toHaveTextContent('Close');
    fireEvent.click(screen.getByTestId('specky-dialogue-footer'));
    expect(onClose).toHaveBeenCalledTimes(1);

    tagAc(AC(8));
    tagAc(AC(2));
  });

  it('renders at most two actions, with primary and quiet treatments (dec-1)', () => {
    const pages: SpeckyDialoguePage[] = [
      {
        key: 'actions',
        heading: 'Actions',
        body: 'body',
        actions: [
          { label: 'Do it', onSelect: () => {}, kind: 'primary', testId: 'primary-action' },
          { label: 'Not now', onSelect: () => {}, kind: 'quiet', testId: 'quiet-action' },
          { label: 'A third', onSelect: () => {}, testId: 'third-action' },
        ],
      },
    ];
    render(<SpeckyDialogue pages={pages} onClose={() => {}} />);

    expect(screen.getByTestId('primary-action')).toBeInTheDocument();
    expect(screen.getByTestId('quiet-action')).toBeInTheDocument();
    expect(screen.queryByTestId('third-action')).toBeNull(); // two max
    expect(screen.getByTestId('primary-action').className).toContain('bg-btn-primary');
    expect(screen.getByTestId('quiet-action').className).not.toContain('bg-btn-primary');
  });

  it('renders no second Specky inside the card — the VoiceLayer avatar is the face (ac-12)', () => {
    render(<SpeckyDialogue pages={twoPages} onClose={() => {}} />);
    const card = screen.getByTestId('specky-dialogue');
    // The Specky character renders as an <img> (guide-sdk Specky.tsx); the card
    // must contain none — one Specky on screen, owned by VoiceLayer (dec-3).
    expect(within(card).queryAllByRole('img')).toHaveLength(0);
    expect(card.querySelector('img')).toBeNull();

    tagAc(AC(12));
  });
});
