// spec-308 ac-6 — even though the Memex keys page widens to max-w-5xl (dec-1),
// the explanatory intro prose stays at a readable measure (max-w-2xl), while the
// Active key table is free to use the full widened width.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { EmissionKeysSection } from './EmissionKeysSection';
import type { EmissionKeySummary } from '../api/client';

const AC_6 = 'mindset-prod/memex-building-itself/specs/spec-308/acs/ac-6';
const AC_3 = 'mindset-prod/memex-building-itself/specs/spec-308/acs/ac-3'; // scope: prose stays at a readable measure
const AC_2 = 'mindset-prod/memex-building-itself/specs/spec-308/acs/ac-2'; // scope: cells don't wrap

const mockList = vi.fn();

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    listEmissionKeysApi: (...args: unknown[]) => mockList(...args),
  };
});

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'tok-1' }),
}));

function key(over: Partial<EmissionKeySummary> = {}): EmissionKeySummary {
  return {
    id: crypto.randomUUID(),
    name: 'pythonia CI',
    prefix: 'mxk_abcd1234',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    scopedSpecHandle: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EmissionKeysSection prose measure (spec-308 ac-6)', () => {
  it('constrains the intro prose, but not the Active table [ac-6]', async () => {
    tagAc(AC_6);
    tagAc(AC_3); // scope: explanatory prose stays at a comfortable reading measure
    mockList.mockResolvedValue([key()]);

    render(<EmissionKeysSection />);

    // The intro prose block is capped at a readable measure.
    const intro = await screen.findByTestId('emission-keys-intro');
    expect(intro.className).toContain('max-w-2xl');

    // The Active key table renders and is NOT nested inside that narrow measure,
    // so it can fill the full widened page width.
    const table = await screen.findByRole('table');
    expect(table).toBeInTheDocument();
    expect(within(intro).queryByRole('table')).toBeNull();
  });

  it('keeps table cells on a single line and lets the table scroll, not crush [ac-2]', async () => {
    tagAc(AC_2);
    // An agent key carries the long metadata ("spec-50", expiry) that previously
    // stacked word-by-word in the narrow column. spec-309 surfaces these under the
    // Agent view, so select it before asserting the table's no-wrap treatment.
    mockList.mockResolvedValue([
      key({
        name: 'agent · spec-50 · 2026-06-19',
        expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        scopedSpecHandle: 'spec-50',
      }),
    ]);

    render(<EmissionKeysSection />);
    fireEvent.click(await screen.findByRole('radio', { name: /Agent/ }));

    const table = await screen.findByTestId('emission-keys-table');
    // whitespace-nowrap makes wrapping physically impossible for every cell
    // (inherited): "Last used"/"Created" headers and the agent metadata stay on
    // one line regardless of column width.
    expect(table.className).toContain('whitespace-nowrap');

    // The table sits inside an overflow-x-auto wrapper, so a too-narrow viewport
    // scrolls horizontally instead of crushing cells into multiple lines.
    const scroller = table.closest('.overflow-x-auto');
    expect(scroller).not.toBeNull();
  });
});
