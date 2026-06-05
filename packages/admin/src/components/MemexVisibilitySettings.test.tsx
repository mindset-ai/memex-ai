import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from "@memex-ai-ac/vitest";
import { MemexVisibilitySettings } from './MemexVisibilitySettings';
import { MemexPublicBadge } from './MemexPublicBadge';
import type { MemexVisibilityDto } from '../api/client';

const AC = 'mindset-prod/memex-building-itself/specs/spec-111/acs/ac-4';

const mockFetchMemex = vi.fn();
const mockUpdateVisibility = vi.fn();

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    fetchMemexApi: (...args: unknown[]) => mockFetchMemex(...args),
    updateMemexVisibilityApi: (...args: unknown[]) => mockUpdateVisibility(...args),
  };
});

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'tok-1' }),
}));

function makeMemex(over: Partial<MemexVisibilityDto> = {}): MemexVisibilityDto {
  return {
    id: 'memex-1',
    namespaceId: 'ns-1',
    slug: 'demo',
    name: 'Demo Memex',
    visibility: 'private',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MemexVisibilitySettings — visibility toggle (ac-4)', () => {
  it('renders the Private/Public control with the exposure warning copy', async () => {
    tagAc(AC);
    mockFetchMemex.mockResolvedValue(makeMemex());
    render(<MemexVisibilitySettings memexId="memex-1" />);

    await screen.findByText('Visibility');
    expect(screen.getByRole('radio', { name: /Private/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Public/ })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Making a Memex public exposes all specs, decisions, comments, and tasks.',
      ),
    ).toBeInTheDocument();
  });

  it('toggling to Public shows the confirm dialog and on confirm PATCHes visibility:public', async () => {
    tagAc(AC);
    const user = userEvent.setup();
    mockFetchMemex.mockResolvedValue(makeMemex({ visibility: 'private' }));
    mockUpdateVisibility.mockResolvedValue(makeMemex({ visibility: 'public' }));

    render(<MemexVisibilitySettings memexId="memex-1" />);
    await screen.findByText('Visibility');

    // Selecting Public must NOT PATCH directly — it opens the §2 confirm gate.
    await user.click(screen.getByRole('radio', { name: /Public/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Make this Memex public?');
    expect(mockUpdateVisibility).not.toHaveBeenCalled();

    // Confirm → PATCH with visibility:'public'.
    await user.click(screen.getByRole('button', { name: 'Make Public' }));
    await waitFor(() =>
      expect(mockUpdateVisibility).toHaveBeenCalledWith('memex-1', 'public', 'tok-1'),
    );

    // UI reflects the new visibility immediately: badge appears, dialog closes.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('memex-public-badge')).toHaveTextContent('Public');
  });

  it('Cancel in the dialog leaves visibility unchanged (no PATCH)', async () => {
    tagAc(AC);
    const user = userEvent.setup();
    mockFetchMemex.mockResolvedValue(makeMemex({ visibility: 'private' }));

    render(<MemexVisibilitySettings memexId="memex-1" />);
    await screen.findByText('Visibility');

    await user.click(screen.getByRole('radio', { name: /Public/ }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockUpdateVisibility).not.toHaveBeenCalled();
    // Still private → no badge.
    expect(screen.queryByTestId('memex-public-badge')).not.toBeInTheDocument();
  });
});

describe('MemexPublicBadge — header badge (ac-4)', () => {
  it('renders the 🌐 Public badge only for a public memex', () => {
    tagAc(AC);
    const { rerender, container } = render(<MemexPublicBadge visibility="public" />);
    const badge = screen.getByTestId('memex-public-badge');
    expect(badge).toHaveTextContent('🌐');
    expect(badge).toHaveTextContent('Public');

    rerender(<MemexPublicBadge visibility="private" />);
    expect(container.querySelector('[data-testid="memex-public-badge"]')).toBeNull();
  });
});
