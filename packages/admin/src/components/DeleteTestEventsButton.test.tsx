// Tests for DeleteTestEventsButton (b-96 t-5). Asserts membership-gated
// visibility (ac-5 / ac-9) and the open-dialog → confirm → DELETE chain
// that drives the matrix refetch (ac-2 / ac-3).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteTestEventsButton } from './DeleteTestEventsButton';
import { discontinueAcTestEvents } from '../api/client';
import { tagAc } from "@memex-ai-ac/vitest";

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>(
    '../api/client',
  );
  return {
    ...actual,
    discontinueAcTestEvents: vi.fn(),
  };
});

const B96 = 'mindset-prod/memex-building-itself/briefs/b-96';

beforeEach(() => {
  vi.mocked(discontinueAcTestEvents).mockReset();
});

describe('DeleteTestEventsButton', () => {
  it('renders the X button when canDelete=true (default) [ac-5]', () => {
    tagAc(`${B96}/acs/ac-5`);
    render(
      <DeleteTestEventsButton
        acId="ac-uuid-1"
        testIdentifier="t_alpha"
        count={3}
        onDeleted={() => undefined}
      />,
    );
    expect(screen.getByTestId('delete-test-events-button')).toBeInTheDocument();
  });

  it('does NOT render the X button when canDelete=false [ac-5, ac-9]', () => {
    tagAc(`${B96}/acs/ac-5`);
    tagAc(`${B96}/acs/ac-9`);
    render(
      <DeleteTestEventsButton
        acId="ac-uuid-1"
        testIdentifier="t_alpha"
        count={3}
        canDelete={false}
        onDeleted={() => undefined}
      />,
    );
    expect(screen.queryByTestId('delete-test-events-button')).toBeNull();
  });

  it('clicking the X button opens the confirmation dialog [ac-2]', () => {
    tagAc(`${B96}/acs/ac-2`);
    render(
      <DeleteTestEventsButton
        acId="ac-uuid-1"
        testIdentifier="t_alpha"
        count={3}
        onDeleted={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-test-events-button'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/permanently delete 3 events/i)).toBeInTheDocument();
  });

  it('confirming fires DELETE then calls onDeleted [ac-2, ac-3]', async () => {
    tagAc(`${B96}/acs/ac-2`);
    tagAc(`${B96}/acs/ac-3`);
    vi.mocked(discontinueAcTestEvents).mockResolvedValue({ deleted: 3 });
    const onDeleted = vi.fn();

    render(
      <DeleteTestEventsButton
        acId="ac-uuid-1"
        testIdentifier="t_alpha"
        count={3}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-test-events-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(discontinueAcTestEvents).toHaveBeenCalledWith(
        'ac-uuid-1',
        't_alpha',
      ),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it('surfaces API errors inline and leaves the dialog open for retry [ac-2]', async () => {
    tagAc(`${B96}/acs/ac-2`);
    vi.mocked(discontinueAcTestEvents).mockRejectedValue(new Error('network boom'));
    const onDeleted = vi.fn();

    render(
      <DeleteTestEventsButton
        acId="ac-uuid-1"
        testIdentifier="t_alpha"
        count={3}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByTestId('delete-test-events-button'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/network boom/i),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    // Dialog still open so the user can retry.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
