import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { EmissionKeysSection } from './EmissionKeysSection';
import type {
  EmissionKeySummary,
  GeneratedEmissionKey,
} from '../api/client';

const AC_15 = 'mindset-prod/memex-building-itself/specs/spec-129/acs/ac-15'; // raw key shown once; list shows prefix only
const AC_11 = 'mindset-prod/memex-building-itself/specs/spec-129/acs/ac-11'; // no anonymous-emission toggle in the UI
const AC_2 = 'mindset-prod/memex-building-itself/specs/spec-129/acs/ac-2'; // SCOPE: owner generates/lists/revokes keys from the settings UI
const AC_4 = 'mindset-prod/memex-building-itself/specs/spec-129/acs/ac-4'; // SCOPE: no anonymous-emission path exists

const mockList = vi.fn();
const mockGenerate = vi.fn();
const mockRevoke = vi.fn();

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    listEmissionKeysApi: (...a: unknown[]) => mockList(...a),
    generateEmissionKeyApi: (...a: unknown[]) => mockGenerate(...a),
    revokeEmissionKeyApi: (...a: unknown[]) => mockRevoke(...a),
  };
});

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'tok-1' }),
}));

function key(over: Partial<EmissionKeySummary> = {}): EmissionKeySummary {
  return {
    id: 'k1',
    name: 'pythonia CI',
    prefix: 'mxk_a1b2c3d4',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EmissionKeysSection (spec-129)', () => {
  it('lists keys by prefix only — never a full secret (ac-15)', async () => {
    tagAc(AC_15);
    tagAc(AC_2); // scope outcome: owner lists keys in the settings UI
    mockList.mockResolvedValue([key()]);
    render(<EmissionKeysSection />);

    const row = await screen.findByText('pythonia CI');
    expect(row).toBeInTheDocument();
    // The non-secret prefix is shown…
    expect(screen.getByText(/mxk_a1b2c3d4…/)).toBeInTheDocument();
    // …and no full-length raw key is rendered anywhere in the list.
    expect(screen.queryByTestId('emission-key-reveal')).not.toBeInTheDocument();
  });

  it('generate reveals the raw key exactly once, then refetches the list (ac-15)', async () => {
    tagAc(AC_15);
    tagAc(AC_2); // scope outcome: owner generates a named key from the UI, shown once
    const user = userEvent.setup();
    mockList.mockResolvedValue([]);
    const generated: GeneratedEmissionKey = {
      ...key({ id: 'k2', name: 'ci-key' }),
      key: 'mxk_THE_RAW_SECRET_VALUE_shown_once',
    };
    mockGenerate.mockResolvedValue(generated);

    render(<EmissionKeysSection />);
    await screen.findByText(/No emission keys yet/);

    await user.type(screen.getByLabelText('New emission key name'), 'ci-key');
    await user.click(screen.getByRole('button', { name: /Generate key/ }));

    // The raw key is revealed once, with the "won't be shown again" warning.
    const reveal = await screen.findByTestId('emission-key-reveal');
    expect(reveal).toHaveTextContent('mxk_THE_RAW_SECRET_VALUE_shown_once');
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();
    expect(mockGenerate).toHaveBeenCalledWith('ci-key', 'tok-1');
    // Generation refetches the list (mount + post-generate).
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));

    // Dismissing removes the reveal — no path re-shows the raw key.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByTestId('emission-key-reveal')).not.toBeInTheDocument(),
    );
  });

  it('revoke calls the API for that key (ac-15 lifecycle)', async () => {
    tagAc(AC_15);
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockList.mockResolvedValue([key()]);
    mockRevoke.mockResolvedValue(key({ revokedAt: new Date().toISOString() }));

    render(<EmissionKeysSection />);
    await screen.findByText('pythonia CI');

    const activeTable = screen.getByText(/Active \(/).closest('div')!;
    await user.click(within(activeTable).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('k1', 'tok-1'));
  });

  it('exposes NO anonymous-emission toggle (dec-3 / dec-7, ac-11)', async () => {
    tagAc(AC_11);
    tagAc(AC_4); // scope outcome: no anonymous-emission path in the UI
    mockList.mockResolvedValue([]);
    render(<EmissionKeysSection />);
    await screen.findByText(/No emission keys yet/);

    expect(screen.queryByText(/anonymous/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
