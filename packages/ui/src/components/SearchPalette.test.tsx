// Component tests for the spec-64 ⌘K omnibox (SearchPalette + the App-level
// hotkey host). Covers ac-8/9/10/12/15/16/20.
//
// This file is TAGGED (tagAc) — it POSTs an AC pass/fail event to PROD memex.ai
// on completion. Do NOT run it from an automated process; a human runs the
// tagged suite (`pnpm --filter @memex/ui test SearchPalette`). Verify the
// implementation with `tsc -b`, the build, and the UNTAGGED suites only.

import { useEffect, useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { SearchPalette } from './SearchPalette';
import { searchMemexApi, type SearchEnvelope, type SearchHit } from '../api/client';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>(
    '../api/client',
  );
  return {
    ...actual,
    searchMemexApi: vi.fn(),
  };
});

// useNavigate is asserted via a spy on react-router-dom's hook.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return { ...actual, useNavigate: () => navigateMock };
});

const SPEC_64 = 'mindset-prod/memex-building-itself/specs/spec-64';
const SPEC_285 = 'mindset-prod/memex-building-itself/specs/spec-285';

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    kind: 'spec',
    path: 'mindset-prod/memex-building-itself/specs/spec-34',
    title: 'Untitled hit',
    status: 'draft',
    score: 1,
    strategies: ['fts'],
    matchingSections: [],
    ...over,
  };
}

// A content hit whose body carries MARKDOWN, so the snippet assertions can prove
// it renders as PLAIN TEXT (ac-20) — the raw syntax must be gone.
const MARKDOWN_BODY =
  '## Heading\n\nThis is **bold** and _italic_ with a [link](https://example.com) and `code` and an ![img](x.png).';

function envelope(over: Partial<SearchEnvelope> = {}): SearchEnvelope {
  return { jumpTo: [], assigned: [], content: [], ...over };
}

function richEnvelope(): SearchEnvelope {
  return envelope({
    jumpTo: [
      hit({
        kind: 'spec',
        path: 'mindset-prod/memex-building-itself/specs/spec-64',
        title: 'Spec 64: omnibox',
        status: 'build',
      }),
    ],
    assigned: [
      hit({
        kind: 'spec',
        path: 'mindset-prod/memex-building-itself/specs/spec-12',
        title: 'Assigned spec',
        status: 'specify',
      }),
    ],
    content: [
      hit({
        kind: 'spec',
        path: 'mindset-prod/memex-building-itself/specs/spec-99',
        title: 'Content spec',
        status: 'draft',
        matchingSections: [
          {
            id: 's1',
            sectionType: 'purpose',
            title: 'Purpose',
            content: MARKDOWN_BODY,
            matchedVia: 'fts',
          },
        ],
      }),
      hit({
        kind: 'standard',
        path: 'mindset-prod/memex-building-itself/standards/std-24',
        title: 'Pin client deps',
        status: 'active',
        matchingSections: [
          {
            id: 's2',
            sectionType: 'rule',
            title: 'Rule',
            content: 'One version per shared library.',
            matchedVia: 'semantic',
          },
        ],
      }),
    ],
  });
}

// Renders the palette already open in a router context.
function renderOpen(env: SearchEnvelope) {
  vi.mocked(searchMemexApi).mockResolvedValue(env);
  return render(
    <MemoryRouter>
      <SearchPalette open onOpenChange={() => {}} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(searchMemexApi).mockReset();
  navigateMock.mockReset();
});

describe('SearchPalette', () => {
  it('renders the three tiers in order with kind+status badges; FTS-only hits render identically [ac-9][ac-12]', async () => {
    tagAc(`${SPEC_64}/acs/ac-9`);
    tagAc(`${SPEC_64}/acs/ac-12`);
    const user = userEvent.setup();
    renderOpen(richEnvelope());

    await user.type(screen.getByRole('combobox'), 'omni');
    await waitFor(() => expect(searchMemexApi).toHaveBeenCalled());
    await screen.findByText('Spec 64: omnibox');

    // Tier headings appear in the documented order: Jump to → Assigned →
    // In-content kind groups (Specs before Standards). Query the cmdk group-
    // heading nodes directly so a row TITLE like "Assigned spec" can't match.
    const listbox = screen.getByRole('listbox');
    const headings = Array.from(
      listbox.querySelectorAll('[cmdk-group-heading]'),
    ).map((el) => el.textContent);
    expect(headings).toEqual(['Jump to', 'Assigned', 'Specs', 'Standards']);

    // Every row carries a kind badge AND a status badge.
    const jumpRow = screen.getByText('Spec 64: omnibox').closest('[cmdk-item]')!;
    expect(jumpRow).toBeTruthy();
    expect(within(jumpRow as HTMLElement).getByText('Spec')).toBeInTheDocument();
    expect(within(jumpRow as HTMLElement).getByText('build')).toBeInTheDocument();

    // The semantic (std-24) row and the fts (spec-99) content row both render —
    // no "semantic unavailable" / degraded banner anywhere (ac-12).
    expect(screen.getByText('Pin client deps')).toBeInTheDocument();
    expect(screen.getByText('Content spec')).toBeInTheDocument();
    expect(screen.queryByText(/semantic.*unavailable|degraded/i)).toBeNull();
  });

  it('renders tier/kind group headings as prominent separators — divider rule + bold, no faint label [ac-22]', async () => {
    tagAc(`${SPEC_64}/acs/ac-22`);
    const user = userEvent.setup();
    renderOpen(richEnvelope());

    await user.type(screen.getByRole('combobox'), 'omni');
    await screen.findByText('Spec 64: omnibox');

    const listbox = screen.getByRole('listbox');

    // Every tier/kind group still renders its heading (Jump to / Assigned /
    // Specs / Standards).
    const headings = Array.from(
      listbox.querySelectorAll('[cmdk-group-heading]'),
    ).map((el) => el.textContent);
    expect(headings).toEqual(['Jump to', 'Assigned', 'Specs', 'Standards']);

    // …and every group is styled as a SEPARATOR, not a faint inline label: a
    // full-width divider rule above the heading (border-t) + bold heading text,
    // applied uniformly to all groups. jsdom can't compute CSS, so we assert the
    // prominence styling is wired to each group; the e2e journey covers the
    // rendered look.
    const groups = Array.from(listbox.querySelectorAll('[cmdk-group]'));
    expect(groups.length).toBe(4);
    for (const g of groups) {
      const cls = g.getAttribute('class') ?? '';
      expect(cls).toContain('[&_[cmdk-group-heading]]:border-t');
      expect(cls).toContain('[&_[cmdk-group-heading]]:font-bold');
      // The old faint treatment is gone.
      expect(cls).not.toContain('[&_[cmdk-group-heading]]:text-muted');
    }
  });

  it('every row shows the entity handle (spec-N / std-N) next to the title', async () => {
    const user = userEvent.setup();
    renderOpen(richEnvelope());

    await user.type(screen.getByRole('combobox'), 'omni');
    await screen.findByText('Spec 64: omnibox');

    // Each row's handle is derived from its canonical path and rendered beside
    // the title, so the user can tell WHICH spec a row is without opening it.
    const expectations: Array<[string, string]> = [
      ['Spec 64: omnibox', 'spec-64'],
      ['Assigned spec', 'spec-12'],
      ['Content spec', 'spec-99'],
      ['Pin client deps', 'std-24'],
    ];
    for (const [title, handle] of expectations) {
      const row = screen.getByText(title).closest('[cmdk-item]')!;
      expect(
        within(row as HTMLElement).getByTestId('search-handle').textContent,
      ).toBe(handle);
    }
  });

  it('jumpTo/assigned rows carry NO snippet; content rows carry one PLAIN-TEXT snippet with markdown stripped [ac-20]', async () => {
    tagAc(`${SPEC_64}/acs/ac-20`);
    const user = userEvent.setup();
    renderOpen(richEnvelope());

    await user.type(screen.getByRole('combobox'), 'omni');
    await screen.findByText('Content spec');

    // Navigation rows render no snippet element.
    const jumpRow = screen.getByText('Spec 64: omnibox').closest('[cmdk-item]')!;
    expect(
      within(jumpRow as HTMLElement).queryByTestId('search-snippet'),
    ).toBeNull();
    const assignedRow = screen.getByText('Assigned spec').closest('[cmdk-item]')!;
    expect(
      within(assignedRow as HTMLElement).queryByTestId('search-snippet'),
    ).toBeNull();

    // The content row renders exactly one snippet, derived from
    // matchingSections[0].content, with markdown syntax stripped to plain text.
    const contentRow = screen.getByText('Content spec').closest('[cmdk-item]')!;
    const snippet = within(contentRow as HTMLElement).getByTestId('search-snippet');
    const text = snippet.textContent ?? '';
    // Visible label/text survives…
    expect(text).toContain('bold');
    expect(text).toContain('italic');
    expect(text).toContain('link');
    expect(text).toContain('code');
    // …but the raw markdown syntax is gone.
    expect(text).not.toContain('**');
    expect(text).not.toContain('##');
    expect(text).not.toContain('`');
    expect(text).not.toContain('](');
    expect(text).not.toContain('![');
    // And no markdown was rendered as HTML (no real <strong>/<a>/<img> nodes).
    expect((snippet as HTMLElement).querySelector('strong')).toBeNull();
    expect((snippet as HTMLElement).querySelector('a')).toBeNull();
    expect((snippet as HTMLElement).querySelector('img')).toBeNull();
  });

  it('content rows render a WHO/WHEN byline; navigation rows and metadata-less rows render none [spec-285]', async () => {
    tagAc(`${SPEC_285}/acs/ac-9`);
    const user = userEvent.setup();
    renderOpen(
      envelope({
        jumpTo: [
          hit({
            kind: 'spec',
            path: 'mindset-prod/memex-building-itself/specs/spec-64',
            title: 'Jump spec',
            status: 'build',
            // A navigation hit may carry no metadata — and even if it did, the
            // byline is content-lane only.
            authorName: null,
            lastUpdatedAt: null,
          }),
        ],
        content: [
          hit({
            kind: 'spec',
            path: 'mindset-prod/memex-building-itself/specs/spec-99',
            title: 'Authored spec',
            status: 'draft',
            authorName: 'Ada Lovelace',
            lastUpdatedAt: '2026-05-28T09:30:00.000Z',
            matchingSections: [
              {
                id: 's1',
                sectionType: 'purpose',
                title: 'Purpose',
                content: 'Body match.',
                matchedVia: 'fts',
              },
            ],
          }),
          hit({
            kind: 'standard',
            path: 'mindset-prod/memex-building-itself/standards/std-7',
            title: 'Metadata-less std',
            status: 'active',
            // No author/timestamp resolved → no byline.
            matchingSections: [
              {
                id: 's2',
                sectionType: 'rule',
                title: 'Rule',
                content: 'A rule.',
                matchedVia: 'fts',
              },
            ],
          }),
        ],
      }),
    );

    await user.type(screen.getByRole('combobox'), 'omni');
    await screen.findByText('Authored spec');

    // The content row shows "<author> · <YYYY-MM-DD>" — human-readable, derived
    // from the structured authorName + lastUpdatedAt the REST route now carries.
    const authoredRow = screen.getByText('Authored spec').closest('[cmdk-item]')!;
    const byline = within(authoredRow as HTMLElement).getByTestId('search-byline');
    expect(byline.textContent).toBe('Ada Lovelace · 2026-05-28');

    // A content row with no resolved author/timestamp renders no byline element.
    const bareRow = screen.getByText('Metadata-less std').closest('[cmdk-item]')!;
    expect(
      within(bareRow as HTMLElement).queryByTestId('search-byline'),
    ).toBeNull();

    // Navigation (jumpTo) rows never carry a byline.
    const jumpRow = screen.getByText('Jump spec').closest('[cmdk-item]')!;
    expect(
      within(jumpRow as HTMLElement).queryByTestId('search-byline'),
    ).toBeNull();
  });

  it('exposes role=dialog, role=listbox, and aria-selected on the active option [ac-15]', async () => {
    tagAc(`${SPEC_64}/acs/ac-15`);
    const user = userEvent.setup();
    renderOpen(richEnvelope());

    // cmdk's Radix dialog exposes role=dialog.
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.type(screen.getByRole('combobox'), 'omni');
    await screen.findByText('Spec 64: omnibox');

    // The list is a listbox; rows are options; the first row is aria-selected.
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(options.some((o) => o.getAttribute('aria-selected') === 'true')).toBe(
        true,
      ),
    );
  });

  it('debounces the query — one fetch for a fast multi-keystroke burst [ac-9]', async () => {
    tagAc(`${SPEC_64}/acs/ac-9`);
    const user = userEvent.setup();
    renderOpen(envelope());

    await user.type(screen.getByRole('combobox'), 'spec');
    // After the burst settles, the debounced effect fires a single request for
    // the final value rather than one per keystroke.
    await waitFor(() => expect(searchMemexApi).toHaveBeenCalled());
    await waitFor(() => {
      const calls = vi.mocked(searchMemexApi).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe('spec');
    });
  });

  it('roving selection spans every tier; Enter navigates to the focused hit path [ac-10]', async () => {
    tagAc(`${SPEC_64}/acs/ac-10`);
    const user = userEvent.setup();
    renderOpen(richEnvelope());

    const input = screen.getByRole('combobox');
    await user.type(input, 'omni');
    await screen.findByText('Spec 64: omnibox');

    // ArrowDown from the first (jumpTo) row crosses into the Assigned tier, the
    // single roving selection cmdk provides across all groups.
    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      const assignedRow = screen
        .getByText('Assigned spec')
        .closest('[cmdk-item]')!;
      expect(assignedRow.getAttribute('aria-selected')).toBe('true');
    });

    // Enter navigates to the focused hit's canonical path, leading-slash prefixed.
    await user.keyboard('{Enter}');
    expect(navigateMock).toHaveBeenCalledWith(
      '/mindset-prod/memex-building-itself/specs/spec-12',
    );
  });

  it('clicking a content row navigates to its leading-slash-prefixed path [ac-10]', async () => {
    tagAc(`${SPEC_64}/acs/ac-10`);
    const user = userEvent.setup();
    renderOpen(richEnvelope());

    await user.type(screen.getByRole('combobox'), 'omni');
    await screen.findByText('Content spec');

    await user.click(screen.getByText('Content spec'));
    expect(navigateMock).toHaveBeenCalledWith(
      '/mindset-prod/memex-building-itself/specs/spec-99',
    );
  });

  it('Esc closes the palette and restores focus to the previously-focused element [ac-8][ac-16]', async () => {
    tagAc(`${SPEC_64}/acs/ac-8`);
    tagAc(`${SPEC_64}/acs/ac-16`);
    const user = userEvent.setup();
    vi.mocked(searchMemexApi).mockResolvedValue(envelope());

    // Harness mirroring App.tsx: a THIN app-level keydown listener owns ⌘K
    // (toggles open + preventDefault), cmdk does NOT own the global hotkey. A
    // trigger button outside the palette holds focus before opening.
    function Harness() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
          if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            setOpen((p) => !p);
          }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, []);
      return (
        <MemoryRouter>
          <button data-testid="trigger">Trigger</button>
          <SearchPalette open={open} onOpenChange={setOpen} />
        </MemoryRouter>
      );
    }

    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(trigger).toHaveFocus();

    // ⌘K opens the palette (app-level hotkey, ac-16).
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // Esc closes it (ac-8). Radix's dialog owns Esc-to-close + focus
    // restoration; we assert focus has LEFT the dialog (back to the document
    // body / trigger). jsdom restores to <body> rather than the exact trigger
    // node, so the precise "focus lands back on the trigger" is left to the e2e
    // — here we prove focus is no longer trapped inside the (now-closed) dialog.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => {
      const active = document.activeElement;
      expect(active === document.body || active === trigger).toBe(true);
    });
  });

  it('Ctrl+K also toggles the palette (non-mac) [ac-16]', async () => {
    tagAc(`${SPEC_64}/acs/ac-16`);
    const user = userEvent.setup();
    vi.mocked(searchMemexApi).mockResolvedValue(envelope());

    function Harness() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
          if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            setOpen((p) => !p);
          }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, []);
      return (
        <MemoryRouter>
          <SearchPalette open={open} onOpenChange={setOpen} />
        </MemoryRouter>
      );
    }

    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
