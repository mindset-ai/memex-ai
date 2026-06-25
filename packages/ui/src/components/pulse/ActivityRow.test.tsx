import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  ActivityRow,
  linkifyNarrative,
  stripRedundantContext,
} from './ActivityRow';
import type { ActivityRow as ActivityRowData } from './types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-122/acs/ac-${n}`;

// ActivityRow renders react-router <Link>s for Spec/Standard handles, so every
// render goes through a MemoryRouter. tenantPath() reads window.location (no
// tenant prefix under jsdom), so deep links come out as bare "/specs/b-N"
// (legacy `b-N` handles still resolve to the new `/specs/` route).
function renderRow(props: Parameters<typeof ActivityRow>[0]) {
  return render(
    <MemoryRouter>
      <ActivityRow {...props} />
    </MemoryRouter>,
  );
}

function row(overrides: Partial<ActivityRowData> = {}): ActivityRowData {
  return {
    id: 'row-1',
    memexId: 'mx-1',
    briefId: 'sb-12',
    actorUserId: 'u-1',
    actorName: 'Barrie',
    actorKind: 'human',
    channel: 'rest_ui',
    clientId: null,
    entity: 'decision',
    action: 'updated',
    narrative: 'Resolved dec-4 in b-12',
    payload: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('linkifyNarrative (exported helper)', () => {
  it('returns the raw string as a single node when there are no handles', () => {
    expect(linkifyNarrative('plain narrative, no handles')).toEqual([
      'plain narrative, no handles',
    ]);
  });

  it('splits handles out of surrounding prose in source order', () => {
    const nodes = linkifyNarrative('Resolved dec-4 in b-12');
    // text "Resolved ", <strong>dec-4</strong>, text " in ", <Link>b-12</Link>
    expect(nodes.length).toBe(4);
    expect(nodes[0]).toBe('Resolved ');
    expect(nodes[2]).toBe(' in ');
  });
});

describe('stripRedundantContext (exported helper)', () => {
  it('drops a trailing "in <handle>" suffix when the context matches', () => {
    expect(stripRedundantContext('Resolved dec-4 in b-12', 'b-12')).toBe(
      'Resolved dec-4',
    );
  });

  it('drops the suffix with a trailing period too', () => {
    expect(stripRedundantContext('Resolved dec-4 in b-12.', 'b-12')).toBe(
      'Resolved dec-4',
    );
  });

  it('leaves the narrative untouched when no context is supplied', () => {
    expect(stripRedundantContext('Resolved dec-4 in b-12')).toBe(
      'Resolved dec-4 in b-12',
    );
  });

  it('leaves the narrative untouched when the suffix handle differs', () => {
    expect(stripRedundantContext('Resolved dec-4 in b-12', 'b-99')).toBe(
      'Resolved dec-4 in b-12',
    );
  });

  it('only strips a trailing occurrence, not a mid-string mention', () => {
    expect(
      stripRedundantContext('Linked b-12 to dec-4 in b-7', 'b-12'),
    ).toBe('Linked b-12 to dec-4 in b-7');
  });
});

describe('ActivityRow — dec-10 information hierarchy', () => {
  it('renders the two-line layout: a WHEN time line over a WHAT narrative line', () => {
    renderRow({ row: row({ narrative: 'Resolved dec-4 in b-12' }) });

    const rendered = screen.getByTestId('activity-row');
    // Line 1 carries the relative time in a <time> element…
    expect(rendered.querySelector('time')).toBeInTheDocument();
    // …Line 2 carries the full narrative, surfaced via the hover title.
    const narrativeLine = rendered.querySelector('[title="Resolved dec-4 in b-12"]');
    expect(narrativeLine).toBeInTheDocument();
  });

  it('exposes entity/action as data attributes for downstream styling', () => {
    renderRow({ row: row({ entity: 'task', action: 'created' }) });
    const rendered = screen.getByTestId('activity-row');
    expect(rendered).toHaveAttribute('data-entity', 'task');
    expect(rendered).toHaveAttribute('data-action', 'created');
  });

  describe('actor rendering — person + surface (spec-122 ac-4)', () => {
    it('renders a human actor as their resolved name, never "You"', () => {
      tagAc(AC(4));
      renderRow({ row: row({ actorKind: 'human', actorName: 'Barrie' }) });
      const rendered = screen.getByTestId('activity-row');
      expect(within(rendered).getByText('Barrie')).toBeInTheDocument();
      expect(rendered.textContent).not.toContain('You');
    });

    it('renders an agent verbatim from its server-resolved "<name>\'s <client>" actorName', () => {
      tagAc(AC(4));
      renderRow({
        row: row({
          actorKind: 'mcp_agent',
          clientId: 'sess-abc123',
          channel: 'mcp',
          actorName: 'Claude Code (Barrie)',
        }),
      });
      const rendered = screen.getByTestId('activity-row');
      expect(within(rendered).getByText('Claude Code (Barrie)')).toBeInTheDocument();
      expect(rendered.textContent).not.toContain('You');
    });

    it('falls back to the channel client label (not "You") for an agent with no actorName', () => {
      tagAc(AC(4));
      renderRow({
        row: row({
          actorKind: 'mcp_agent',
          clientId: 'sess-abc123',
          channel: 'mcp',
          actorName: null,
        }),
      });
      const rendered = screen.getByTestId('activity-row');
      // clientLabel('mcp', 'sess-abc123') → "MCP · sess-a"
      expect(within(rendered).getByText(/MCP ·/)).toBeInTheDocument();
      expect(rendered.textContent).not.toContain('You');
    });

    it('renders a raw CI actor string VERBATIM and never collapses it to "You"', () => {
      tagAc(AC(4));
      // A free-form CI actor: no actorUserId, name arrives as the raw string.
      renderRow({
        row: row({
          actorKind: 'human',
          actorUserId: null,
          clientId: null,
          actorName: 'CI · abc123',
        }),
      });
      const rendered = screen.getByTestId('activity-row');
      expect(within(rendered).getByText('CI · abc123')).toBeInTheDocument();
      expect(rendered.textContent).not.toContain('You');
    });

    it('renders system activity as a plain "System" — no parens, no client', () => {
      renderRow({ row: row({ actorKind: 'system', clientId: null }) });
      const rendered = screen.getByTestId('activity-row');
      expect(within(rendered).getByText('System')).toBeInTheDocument();
      expect(rendered.textContent).not.toContain('(');
    });
  });

  describe('presence-aware regression flag (spec-122 ac-2)', () => {
    it('mutes the REGRESSED flag while the spec has an active worker (expected churn)', () => {
      tagAc(AC(2));
      renderRow({ row: row(), regressed: true, regressionMuted: true });
      const flag = screen.getByTestId('regressed-flag');
      expect(flag).toHaveAttribute('data-muted', 'true');
      expect(flag.className).toContain('text-muted/70');
    });

    it('renders the EARNED alarm flag on a quiet (unworked) regression', () => {
      tagAc(AC(2));
      renderRow({ row: row(), regressed: true, regressionMuted: false });
      const flag = screen.getByTestId('regressed-flag');
      expect(flag).toHaveAttribute('data-muted', 'false');
      expect(flag.className).toContain('text-status-danger-text');
    });

    it('renders the two states DIFFERENTLY (class + aria)', () => {
      tagAc(AC(2));
      const { unmount } = renderRow({ row: row(), regressed: true, regressionMuted: true });
      const mutedFlag = screen.getByTestId('regressed-flag');
      const mutedClass = mutedFlag.className;
      const mutedAria = mutedFlag.getAttribute('aria-label');
      unmount();

      renderRow({ row: row(), regressed: true, regressionMuted: false });
      const alarmFlag = screen.getByTestId('regressed-flag');
      expect(alarmFlag.className).not.toBe(mutedClass);
      expect(alarmFlag.getAttribute('aria-label')).not.toBe(mutedAria);
    });

    it('renders no flag when the row is not a regression', () => {
      renderRow({ row: row(), regressed: false });
      expect(screen.queryByTestId('regressed-flag')).toBeNull();
    });
  });

  describe('handle styling in the narrative', () => {
    it('renders a Spec handle (b-N legacy / spec-N) as a BOLD deep link', () => {
      renderRow({ row: row({ narrative: 'Touched b-12' }) });
      const link = screen.getByRole('link', { name: 'b-12' });
      expect(link).toHaveAttribute('href', '/specs/b-12');
      // dec-10: the resource handle is bold (font-semibold).
      expect(link.className).toContain('font-semibold');
    });

    it('renders a Standard handle (std-N) as a BOLD deep link', () => {
      renderRow({ row: row({ narrative: 'Updated std-3' }) });
      const link = screen.getByRole('link', { name: 'std-3' });
      expect(link).toHaveAttribute('href', '/standards/std-3');
      expect(link.className).toContain('font-semibold');
    });

    it('renders child handles (dec/t/c/s-N) as BOLD but UNLINKED', () => {
      renderRow({
        row: row({ narrative: 'Resolved dec-4, closed t-7, replied to c-2, edited s-1' }),
      });
      // None of the child handles are links…
      expect(screen.queryByRole('link', { name: 'dec-4' })).toBeNull();
      expect(screen.queryByRole('link', { name: 't-7' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'c-2' })).toBeNull();
      expect(screen.queryByRole('link', { name: 's-1' })).toBeNull();
      // …but each renders bold (a <strong>).
      for (const handle of ['dec-4', 't-7', 'c-2', 's-1']) {
        const el = screen.getByText(handle);
        expect(el.tagName).toBe('STRONG');
        expect(el.className).toContain('font-semibold');
      }
    });

    it('strips a redundant "in <contextBriefHandle>" suffix from the rendered narrative', () => {
      renderRow({
        row: row({ narrative: 'Resolved dec-4 in b-12' }),
        contextBriefHandle: 'b-12',
      });
      const rendered = screen.getByTestId('activity-row');
      // The narrative line no longer mentions b-12 (the context already says where).
      expect(within(rendered).queryByRole('link', { name: 'b-12' })).toBeNull();
      expect(within(rendered).getByText('dec-4')).toBeInTheDocument();
    });
  });

  describe('burst / group mode (groupCount > 1)', () => {
    it('renders the collapsed summary with an N-actions count + expand affordance when collapsed', () => {
      renderRow({
        row: row({ narrative: 'Resolved dec-4 in b-12' }),
        groupCount: 3,
        expanded: false,
      });

      const summary = screen.getByTestId('activity-row-group');
      expect(summary).toHaveAttribute('aria-expanded', 'false');
      expect(summary).toHaveTextContent('3 actions');
      // The Spec is the summary anchor — a deep link to b-12.
      expect(
        within(summary).getByRole('link', { name: 'b-12' }),
      ).toHaveAttribute('href', '/specs/b-12');
      // The single-row layout is NOT rendered while collapsed.
      expect(screen.queryByTestId('activity-row')).toBeNull();
    });

    it('fires onToggleExpand when the collapsed summary is clicked', async () => {
      const onToggleExpand = vi.fn();
      renderRow({
        row: row(),
        groupCount: 4,
        expanded: false,
        onToggleExpand,
      });

      await userEvent.click(screen.getByTestId('activity-row-group'));
      expect(onToggleExpand).toHaveBeenCalledTimes(1);
    });

    it('renders the full row with a Collapse affordance when expanded', () => {
      renderRow({
        row: row(),
        groupCount: 3,
        expanded: true,
      });

      // Expanded groups render the normal row plus a "Collapse" toggle.
      expect(screen.getByTestId('activity-row')).toBeInTheDocument();
      expect(screen.queryByTestId('activity-row-group')).toBeNull();
      const collapse = screen.getByRole('button', { name: 'Collapse' });
      expect(collapse).toHaveAttribute('aria-expanded', 'true');
    });

    it('renders the plain single row (no group affordance) when groupCount <= 1', () => {
      renderRow({ row: row(), groupCount: 1 });
      expect(screen.getByTestId('activity-row')).toBeInTheDocument();
      expect(screen.queryByTestId('activity-row-group')).toBeNull();
    });
  });
});
