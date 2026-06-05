// Tests for AcMatrixCollapsible (b-96 t-4). Asserts the inline-collapsible
// behaviour required by dec-16 + ac-10: each AC row has its own accordion;
// multiple ACs can be expanded simultaneously; the matrix is mounted inline,
// not in a modal or behind a separate route.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcMatrixCollapsible } from './AcMatrixCollapsible';
import { fetchAcTestMatrix } from '../api/client';
import { tagAc } from "@memex-ai-ac/vitest";

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>(
    '../api/client',
  );
  return {
    ...actual,
    fetchAcTestMatrix: vi.fn(),
  };
});

const B96 = 'mindset-prod/memex-building-itself/briefs/b-96';

beforeEach(() => {
  vi.mocked(fetchAcTestMatrix).mockReset();
});

describe('AcMatrixCollapsible', () => {
  it('starts collapsed; clicking the toggle opens the accordion and fetches [ac-10]', async () => {
    tagAc(`${B96}/acs/ac-10`);
    vi.mocked(fetchAcTestMatrix).mockResolvedValue([
      {
        testIdentifier: 't_alpha',
        emissions: [{ status: 'pass', emittedAt: '2026-05-27T00:00:00Z' }],
      },
    ]);

    render(<AcMatrixCollapsible acId="ac-uuid-1" testCount={1} />);

    // Initially closed: no fetch fired, no matrix mounted.
    const wrapper = screen.getByTestId('ac-matrix-collapsible');
    expect(wrapper.getAttribute('data-open')).toBe('false');
    expect(fetchAcTestMatrix).not.toHaveBeenCalled();

    // Toggle.
    fireEvent.click(screen.getByRole('button', { name: /show test history/i }));

    expect(wrapper.getAttribute('data-open')).toBe('true');
    await waitFor(() =>
      expect(fetchAcTestMatrix).toHaveBeenCalledWith('ac-uuid-1'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('test-matrix-row')).toBeInTheDocument(),
    );
  });

  it('mounts inline (no modal, no separate route) [ac-10]', async () => {
    tagAc(`${B96}/acs/ac-10`);
    vi.mocked(fetchAcTestMatrix).mockResolvedValue([]);

    const { container } = render(
      <AcMatrixCollapsible acId="ac-uuid-1" testCount={0} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /show test history/i }));
    await waitFor(() =>
      expect(screen.getByText(/no events recorded/i)).toBeInTheDocument(),
    );

    // No portal / no role=dialog / no router transition: the matrix content
    // is a descendant of the same root we rendered into.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.getByText(/no events recorded/i).closest('[data-testid="ac-matrix-collapsible"]')).not.toBeNull();
  });

  it('multiple collapsibles can be open simultaneously [ac-10]', async () => {
    tagAc(`${B96}/acs/ac-10`);
    vi.mocked(fetchAcTestMatrix).mockResolvedValue([
      {
        testIdentifier: 't_only',
        emissions: [{ status: 'pass', emittedAt: '2026-05-27T00:00:00Z' }],
      },
    ]);

    render(
      <>
        <AcMatrixCollapsible acId="ac-1" testCount={1} />
        <AcMatrixCollapsible acId="ac-2" testCount={1} />
      </>,
    );

    const toggles = screen.getAllByRole('button', { name: /show test history/i });
    expect(toggles).toHaveLength(2);

    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);

    await waitFor(() =>
      expect(screen.getAllByTestId('ac-matrix-collapsible')).toHaveLength(2),
    );
    const wrappers = screen.getAllByTestId('ac-matrix-collapsible');
    expect(wrappers[0].getAttribute('data-open')).toBe('true');
    expect(wrappers[1].getAttribute('data-open')).toBe('true');

    // Each row fetched independently.
    expect(fetchAcTestMatrix).toHaveBeenCalledWith('ac-1');
    expect(fetchAcTestMatrix).toHaveBeenCalledWith('ac-2');
    expect(fetchAcTestMatrix).toHaveBeenCalledTimes(2);
  });

  it('clicking the toggle a second time collapses (without refetching) [ac-10]', async () => {
    tagAc(`${B96}/acs/ac-10`);
    vi.mocked(fetchAcTestMatrix).mockResolvedValue([]);

    render(<AcMatrixCollapsible acId="ac-uuid-1" testCount={0} />);
    const toggle = screen.getByRole('button', { name: /show test history/i });

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(fetchAcTestMatrix).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole('button', { name: /hide test history/i }));
    expect(screen.getByTestId('ac-matrix-collapsible').getAttribute('data-open')).toBe('false');

    // Reopen — should NOT trigger a second fetch (cached rows).
    fireEvent.click(screen.getByRole('button', { name: /show test history/i }));
    expect(fetchAcTestMatrix).toHaveBeenCalledTimes(1);
  });

  it('surfaces fetch errors to the user instead of swallowing them [ac-1]', async () => {
    tagAc(`${B96}/acs/ac-1`);
    vi.mocked(fetchAcTestMatrix).mockRejectedValue(new Error('boom'));

    render(<AcMatrixCollapsible acId="ac-uuid-1" />);
    fireEvent.click(screen.getByRole('button', { name: /show test history/i }));

    await waitFor(() =>
      expect(screen.getByText(/boom/i)).toBeInTheDocument(),
    );
  });
});
