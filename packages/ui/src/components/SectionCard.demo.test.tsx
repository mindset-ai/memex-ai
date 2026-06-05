// spec-178 (A-UI, t-7): the demo variant of SectionCard suppresses handle
// auto-linking so a frozen demo spec's `[per dec-N]` / canonical-path refs render
// as plain text — they belong to the original spec-64's world, not the user's.
// ac-24 covers the suppression; ac-11 pins the no-regression baseline (a real,
// non-demo section keeps its auto-links and renders unchanged).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SectionCard } from './SectionCard';
import type { DocSection } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC_178 = 'mindset-prod/memex-building-itself/specs/spec-178';
const AC = (n: number) => `${SPEC_178}/acs/ac-${n}`;

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: vi.fn() }),
}));
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', name: 'Tester' } }),
}));
vi.mock('../api/client', () => ({
  resolveComment: vi.fn().mockResolvedValue({}),
  deleteComment: vi.fn().mockResolvedValue(undefined),
  createComment: vi.fn().mockResolvedValue({}),
}));

// A canonical path ref the refLinkifier auto-links when present (it matches the
// REF_PATTERN: <ns>/<mx>/specs/spec-N). In a real section this becomes an <a>;
// in a demo section it must stay plain text.
const REF = 'mindset-prod/memex-building-itself/specs/spec-34';

function makeSection(overrides: Partial<DocSection> = {}): DocSection {
  return {
    id: 'sec-1',
    docId: 'doc-1',
    sectionType: 'approach',
    title: 'Approach',
    content: `See ${REF} for the prior art.`,
    seq: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as DocSection;
}

beforeEach(() => vi.clearAllMocks());

describe('SectionCard demo handle suppression (spec-178)', () => {
  it('ac-24: a demo section renders a handle ref as plain text — no <a> auto-link', () => {
    tagAc(AC(24));
    render(<SectionCard section={makeSection()} sectionNumber={1} isDemo />);
    const body = screen.getByTestId('section-body');
    // The ref text is present...
    expect(body).toHaveTextContent(REF);
    // ...but it is NOT wrapped in an anchor (the refLinkifier was suppressed).
    expect(body.querySelector('a')).toBeNull();
    expect(body.querySelector('[data-ref-link="true"]')).toBeNull();
  });

  it('ac-11: a non-demo section renders unchanged — the handle ref IS an auto-link', () => {
    tagAc(AC(11));
    render(<SectionCard section={makeSection()} sectionNumber={1} />);
    const body = screen.getByTestId('section-body');
    const link = within(body).getByRole('link', { name: REF });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', `/${REF}`);
    expect(link).toHaveAttribute('data-ref-link', 'true');
  });

  it('ac-11: isDemo defaults to false — omitting the prop keeps auto-linking', () => {
    tagAc(AC(11));
    // No isDemo prop at all (default path) → real-spec behaviour.
    render(<SectionCard section={makeSection()} sectionNumber={1} isDemo={false} />);
    const body = screen.getByTestId('section-body');
    expect(body.querySelector('[data-ref-link="true"]')).not.toBeNull();
  });
});
