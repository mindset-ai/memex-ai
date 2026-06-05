// Tests for DeleteTestEventsDialog (b-96 t-5). The dialog wording is
// load-bearing per dec-13: exact count + explicit acknowledgement.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteTestEventsDialog } from './DeleteTestEventsDialog';
import { tagAc } from "@memex-ai-ac/vitest";

const B96 = 'mindset-prod/memex-building-itself/briefs/b-96';

describe('DeleteTestEventsDialog', () => {
  it('renders the exact wording with the exact emission count [ac-7]', () => {
    tagAc(`${B96}/acs/ac-7`);
    render(
      <DeleteTestEventsDialog
        testIdentifier="t_alpha"
        count={3}
        onConfirm={async () => undefined}
        onClose={() => undefined}
      />,
    );
    // The wording is verbatim from dec-13. Any drift here would be a
    // contract violation; pinning it in the test makes the contract explicit.
    expect(
      screen.getByText(
        'Permanently delete 3 events for this test? It will only reappear if it next emits.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('t_alpha')).toBeInTheDocument();
  });

  it('uses singular "event" when count is 1 [ac-7]', () => {
    tagAc(`${B96}/acs/ac-7`);
    render(
      <DeleteTestEventsDialog
        testIdentifier="t_only"
        count={1}
        onConfirm={async () => undefined}
        onClose={() => undefined}
      />,
    );
    expect(
      screen.getByText(
        'Permanently delete 1 event for this test? It will only reappear if it next emits.',
      ),
    ).toBeInTheDocument();
  });

  it('Cancel closes without firing onConfirm [ac-7]', () => {
    tagAc(`${B96}/acs/ac-7`);
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <DeleteTestEventsDialog
        testIdentifier="t_x"
        count={2}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click closes without firing onConfirm [ac-7]', () => {
    tagAc(`${B96}/acs/ac-7`);
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <DeleteTestEventsDialog
        testIdentifier="t_x"
        count={2}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes without firing onConfirm [ac-7]', () => {
    tagAc(`${B96}/acs/ac-7`);
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <DeleteTestEventsDialog
        testIdentifier="t_x"
        count={2}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('explicit Delete button click fires onConfirm [ac-2, ac-7]', async () => {
    tagAc(`${B96}/acs/ac-2`);
    tagAc(`${B96}/acs/ac-7`);
    const onConfirm = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <DeleteTestEventsDialog
        testIdentifier="t_x"
        count={2}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
