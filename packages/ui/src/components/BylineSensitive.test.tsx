// spec-535 t-6 — the byline control that sets and clears the sensitivity flag.
//
// dec-4 split the setter from the signal: this component is the SETTER, and it
// lives where the requirement asked for it — the byline row, beside the assignee
// and tag affordances. The warning itself is a banner near the title (t-7),
// because a danger signal wearing the byline's muted-metadata costume is
// camouflaged by it.
//
// The two properties worth testing here are both about restraint: there is no
// person-picker (flagging is a self-action — whoever sets it becomes the contact,
// dec-2), and a reader without write access sees no control at all while still
// seeing the warning elsewhere.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BylineSensitive } from './BylineSensitive';

const setDocSensitive = vi.fn();
const clearDocSensitive = vi.fn();

vi.mock('../api/client', () => ({
  setDocSensitive: (...a: unknown[]) => setDocSensitive(...a),
  clearDocSensitive: (...a: unknown[]) => clearDocSensitive(...a),
}));

let mockCanWrite = true;
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: mockCanWrite }),
}));

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockCanWrite = true;
  setDocSensitive.mockResolvedValue(undefined);
  clearDocSensitive.mockResolvedValue(undefined);
});

describe('BylineSensitive (spec-535 t-6)', () => {
  it('ac-17: an editor sees the control on an unflagged Spec and one click flags it', async () => {
    tagAc(AC(17));
    const onChange = vi.fn();
    render(<BylineSensitive docId="d-1" sensitive={false} onChange={onChange} />);

    const button = screen.getByRole('button', { name: /sensitive/i });
    await userEvent.click(button);

    await waitFor(() => expect(setDocSensitive).toHaveBeenCalledWith('d-1'));
    expect(clearDocSensitive).not.toHaveBeenCalled();
    // The page owns the flag state; the control reports upward rather than
    // holding a second copy that can drift from the document read.
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('ac-17: on a flagged Spec the same control clears it', async () => {
    tagAc(AC(17));
    render(<BylineSensitive docId="d-1" sensitive onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /sensitive/i }));

    await waitFor(() => expect(clearDocSensitive).toHaveBeenCalledWith('d-1'));
    expect(setDocSensitive).not.toHaveBeenCalled();
  });

  it('ac-17: there is no person-picker — flagging is a self-action', async () => {
    tagAc(AC(17));
    render(<BylineSensitive docId="d-1" sensitive={false} onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /sensitive/i }));

    // dec-2 chose "the flagger IS the contact" precisely so no fourth "who"
    // concept had to exist. A picker appearing here would mean someone
    // reintroduced it in the UI without the decision.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ac-17: a reader without write access sees no control at all', () => {
    tagAc(AC(17));
    mockCanWrite = false;
    const { container } = render(
      <BylineSensitive docId="d-1" sensitive onChange={vi.fn()} />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    // Renders nothing rather than an empty wrapper — the byline separators are
    // gated on the control existing, so an empty node leaves an orphan dot.
    expect(container).toBeEmptyDOMElement();
  });

  it('ac-17: the control has an accessible name distinct from Assign and Tag', () => {
    tagAc(AC(17));
    render(<BylineSensitive docId="d-1" sensitive={false} onChange={vi.fn()} />);

    const name = screen.getByRole('button').getAttribute('aria-label') ?? '';
    expect(name.toLowerCase()).toContain('sensitive');
    expect(name.toLowerCase()).not.toContain('assign');
    expect(name.toLowerCase()).not.toContain('tag');
  });

  it('ac-3: a failed write leaves the control usable rather than stuck', async () => {
    tagAc(AC(3));
    setDocSensitive.mockRejectedValue(new Error('nope'));
    render(<BylineSensitive docId="d-1" sensitive={false} onChange={vi.fn()} />);

    const button = screen.getByRole('button', { name: /sensitive/i });
    await userEvent.click(button);

    // The flag blocks nothing by design, so its own control must not become the
    // thing that blocks: a rejected request re-enables the button.
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
