// spec-558 t-3 / dec-1 — the Issue card is TWO zones: a title strip that takes
// clicks and a content zone that takes none.
//
//   • ac-6 — the content zone is a SIBLING of the title strip, not a descendant
//     of it. Until they are siblings neither the fill nor the click behaviour
//     can differ, so the structural relationship is the claim, not the mere
//     presence of both elements.
//   • ac-7 — no code path in IssuePanel reads a selection. The fix is
//     structural; a guard reappearing here would mean the click target came
//     back.
//   • ac-2 / ac-3 — the strip toggles both ways; the content zone answers
//     nothing.
//
// WHAT THIS TIER CANNOT PROVE, deliberately. jsdom never produces a
// mousedown→drag→mouseup→click sequence, so "selecting text leaves the card
// open" (ac-1) lives in journey-74 and only there. A test here that stubbed
// `window.getSelection` would assert a guard this Spec specifically does NOT
// have — it would pass against an implementation that reintroduced the bug.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { IssuePanel } from './IssuePanel';
import type { Issue } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-558/acs/ac-${n}`;

const mockFetchIssues = vi.fn();
const mockAddContextChip = vi.fn();

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: mockAddContextChip }),
}));
vi.mock('../hooks/useDocChangeStream', () => ({
  useDocChangeStream: () => {},
}));
vi.mock('../api/client', () => ({
  fetchIssues: (...a: unknown[]) => mockFetchIssues(...a),
  createIssueApi: vi.fn(),
  updateIssueStatusApi: vi.fn(),
  convertIssueToTaskApi: vi.fn(),
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'iss-1',
    docId: 'doc-1',
    seq: 1,
    title: 'An issue whose body you want to copy',
    body: 'The quick brown fox jumps over the lazy dog.',
    type: 'bug',
    severity: null,
    status: 'open',
    source: 'human',
    satisfyingTaskId: null,
    promotedDocId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Issue;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchIssues.mockResolvedValue([makeIssue()]);
});

/** Render, open the card via its strip, and hand back the three elements. */
async function openCard() {
  render(<IssuePanel docId="doc-1" />);
  const card = await screen.findByTestId('issue-card');
  const strip = within(card).getByTestId('issue-strip');
  fireEvent.click(strip);
  const content = within(card).getByTestId('issue-expanded');
  return { card, strip, content };
}

describe('spec-558: the Issue card is two zones', () => {
  it('ac-6: the content zone is a SIBLING of the title strip, not nested inside it', async () => {
    tagAc(AC(6));
    const { card, strip, content } = await openCard();

    // The claim is the relationship, so assert it from both directions rather
    // than merely finding both elements on the page.
    expect(strip.contains(content)).toBe(false);
    expect(content.parentElement).toBe(card);
    expect(strip.parentElement).toBe(card);
  });

  it('ac-3: the content zone answers no click, and no ancestor toggles on its behalf', async () => {
    tagAc(AC(3));
    const { card, content } = await openCard();

    fireEvent.click(content);
    expect(within(card).queryByTestId('issue-expanded')).not.toBeNull();

    // A double-click is two clicks: if anything above were listening, the card
    // would flicker shut. It also stands in for the word-select gesture, which
    // is the one a reader uses to copy a single term.
    fireEvent.doubleClick(content);
    expect(within(card).queryByTestId('issue-expanded')).not.toBeNull();

    // And the content zone must not reach the chat store either — the card
    // wrapper used to own a handler, so this is the same absence, checked on
    // the other consumer.
    expect(mockAddContextChip).not.toHaveBeenCalled();
  });

  it('ac-2: one click on the strip opens, the same click closes', async () => {
    tagAc(AC(2));
    render(<IssuePanel docId="doc-1" />);
    const card = await screen.findByTestId('issue-card');
    const strip = within(card).getByTestId('issue-strip');

    expect(within(card).queryByTestId('issue-expanded')).toBeNull();
    fireEvent.click(strip);
    expect(within(card).queryByTestId('issue-expanded')).not.toBeNull();
    expect(strip).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(strip);
    expect(within(card).queryByTestId('issue-expanded')).toBeNull();
    expect(strip).toHaveAttribute('aria-expanded', 'false');
  });

  it('ac-9: the hover cue lives on the strip, so the inert zone promises nothing', async () => {
    tagAc(AC(9));
    const { card, strip, content } = await openCard();

    // The hover group and the pointer cursor belong to the click target. On the
    // card they meant the inert content zone still faded in the focus icon and
    // still showed a pointer — a promise the zone cannot keep.
    expect(strip.className).toContain('group/issue');
    expect(strip.className).toContain('cursor-pointer');
    expect(strip.className).toContain('hover:bg-card-hover');

    expect(card.className).not.toContain('group/issue');
    expect(card.className).not.toContain('cursor-pointer');
    expect(card.className).not.toContain('hover:');
    expect(content.className).not.toContain('cursor-pointer');
    expect(content.className).not.toContain('hover:');
  });

  it('ac-7: no code path in IssuePanel reads a text selection', () => {
    tagAc(AC(7));
    // A claim about the SHAPE of the module, so the honest evidence is the
    // source itself — there is no runtime state to observe, which is the whole
    // point of the design. dec-1 rejected three guard-shaped options in favour
    // of removing the click target; a selection API reappearing in this file
    // would mean the target came back.
    const source = readFileSync(join(__dirname, 'IssuePanel.tsx'), 'utf8');

    // Comments legitimately discuss selections, so strip them before scanning
    // — otherwise this test would pin the prose rather than the code.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const api of ['getSelection', 'intersectsNode', 'commonAncestorContainer', 'createRange']) {
      expect(code, `IssuePanel should not reach for ${api}`).not.toContain(api);
    }

    // Vacuity guard: prove the scrub left real code behind, so a regex that
    // accidentally emptied the file could never make this pass [per std-45 cl-4].
    expect(code).toContain('toggleExpanded');
    expect(code).toContain('issue-strip');
  });
});
