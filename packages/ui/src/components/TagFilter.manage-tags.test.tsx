// spec-418 t-5 (ac-9) — the SINGLE entry point to the Manage-tags surface is a
// "Manage tags" row inside the TagFilter dropdown. There is exactly one such
// affordance, it links to the tenant `/specs/tags` path (path-based nav), and no
// board-header/overflow mirror exists.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import type { Tag } from '../api/types';

const AC = 'mindset-prod/memex-building-itself/specs/spec-418/acs';
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track: vi.fn(), optedOut: false, setOptOut: vi.fn() }),
}));

const CATALOGUE: Tag[] = [
  { id: 't1', memexId: 'm1', scope: 'priority', value: 'high', createdAt: '2026-01-01T00:00:00Z' },
];
vi.mock('../api/client', () => ({
  fetchMemexTags: vi.fn(async () => CATALOGUE),
}));

import { TagFilter } from './TagFilter';

describe('TagFilter — Manage tags entry (ac-9)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders exactly one "Manage tags" link to /specs/tags in the dropdown', async () => {
    tagAc(`${AC}/ac-9`);
    render(
      <MemoryRouter>
        <TagFilter selected={[]} onChange={vi.fn()} />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByTestId('tag-filter-toggle'));

    const entries = await screen.findAllByTestId('tag-filter-manage');
    expect(entries).toHaveLength(1);
    // Path-based nav to the tenant surface (no tenant in the test URL → bare path).
    expect(entries[0].getAttribute('href')).toBe('/specs/tags');
    expect(entries[0]).toHaveTextContent(/manage tags/i);
  });

  it('has NO board-header / overflow mirror — the dropdown is the only entry', () => {
    tagAc(`${AC}/ac-9`);
    // The board renders TagFilter; assert it carries no separate manage-tags entry
    // of its own (the single entry lives in TagFilter, tested above).
    const specList = readFileSync(join(SRC_DIR, '../pages/SpecList.tsx'), 'utf8');
    expect(specList).not.toMatch(/specs\/tags/);
    expect(specList).not.toMatch(/Manage tags/);
  });
});
