// spec-521 t-5 (ac-14) — supersession on the web is DISPLAY-ONLY.
//
// The positive half of this AC (a banner renders) is the easy half. The half that
// matters is the NEGATIVE: no control anywhere sets or clears supersession, no
// web-exposed route writes the columns, and no copy suggests the user could. dec-4
// made that call ("No supersede button needed for the website. This will purely be an
// MCP tool"), and dec-4's own rationale names the failure a half-wired control
// produces — spec-93's candidate-decision radios silently dropped the user's pick.
//
// So the structural assertions below scan the UI source. A test that only checked the
// banner renders would pass on the day someone added a "Mark superseded" button.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagAc } from '@memex-ai-ac/vitest';
import { SupersededByBanner, ReplacesBanner } from './SupersessionBanner';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-521/acs/ac-${n}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Non-test UI sources with comments stripped — structural scans must not match the
 *  prose that EXPLAINS the rule (this Spec's own comments discuss supersede_spec at
 *  length, which a naive whole-file grep would flag as a violation of itself). */
function uiCodeFiles(): { path: string; code: string }[] {
  return walk(UI_SRC).map((path) => ({
    path,
    code: readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
      .join('\n'),
  }));
}

describe('ac-14 — the superseded Spec renders a banner naming its successor', () => {
  it('names the successor, the date and the note, with the successor as a link', () => {
    tagAc(AC(14));
    render(
      <MemoryRouter>
        <SupersededByBanner
          successorHandle="spec-510"
          supersededAt="2026-08-05T09:00:00.000Z"
          note="absorbed into the channel-aware footer projection"
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('superseded-by-banner')).toBeInTheDocument();
    expect(screen.getByText(/Superseded by/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'spec-510' })).toBeInTheDocument();
    expect(screen.getByText(/5 Aug 2026/)).toBeInTheDocument();
    expect(
      screen.getByText(/absorbed into the channel-aware footer projection/),
    ).toBeInTheDocument();
  });

  it('is a role="status" region so a screen reader announces it', () => {
    tagAc(AC(14));
    render(
      <MemoryRouter>
        <SupersededByBanner successorHandle="spec-510" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('does not rely on colour alone — the meaning is in the TEXT', () => {
    tagAc(AC(14));
    // The accessibility requirement in design §"Accessibility": a superseded Spec must
    // read as superseded to a screen reader and in high-contrast mode, where every
    // colour cue is gone.
    const { container } = render(
      <MemoryRouter>
        <SupersededByBanner successorHandle="spec-510" />
      </MemoryRouter>,
    );
    const text = container.textContent ?? '';
    expect(text.toLowerCase()).toContain('superseded');
    expect(text).toContain('spec-510');
  });

  it('degrades without a date or a note', () => {
    tagAc(AC(14));
    const { container } = render(
      <MemoryRouter>
        <SupersededByBanner successorHandle="spec-510" supersededAt={null} note={null} />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('spec-510');
    expect(container.textContent).not.toContain('null');
    expect(container.textContent).not.toContain('undefined');
  });

  it('the successor renders the mirror as ONE line, however many predecessors', () => {
    tagAc(AC(14));
    render(
      <MemoryRouter>
        <ReplacesBanner predecessorHandles={['spec-245', 'spec-428', 'spec-99']} />
      </MemoryRouter>,
    );
    const banner = screen.getByTestId('replaces-banner');
    // One paragraph, not three.
    expect(banner.querySelectorAll('p')).toHaveLength(1);
    expect(banner.textContent).toContain('spec-245');
    expect(banner.textContent).toContain('spec-428');
    expect(banner.textContent).toContain('spec-99');
  });

  it('renders nothing when there are no predecessors', () => {
    tagAc(AC(14));
    const { container } = render(
      <MemoryRouter>
        <ReplacesBanner predecessorHandles={[]} />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('ac-14 — display-only: no control, no write path, no misleading copy', () => {
  it('the banner renders NO button, input, or form control', () => {
    tagAc(AC(14));
    render(
      <MemoryRouter>
        <SupersededByBanner successorHandle="spec-510" note="absorbed" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('NO UI source writes the supersession columns or calls a supersede endpoint', () => {
    tagAc(AC(14));
    for (const { path, code } of uiCodeFiles()) {
      // No API client function, no fetch, no route hitting a supersede endpoint.
      expect(code, `${path} must not call a supersede endpoint`).not.toMatch(
        /['"`][^'"`]*\/supersede[^'"`]*['"`]/,
      );
      expect(code, `${path} must not define a supersede mutation`).not.toMatch(
        /function\s+supersedeDoc|function\s+supersedeSpec|supersedeDoc\s*\(/,
      );
    }
  });

  it('NO PromptButton naming supersede_spec is added (std-34: none is owed here)', () => {
    tagAc(AC(14));
    // A page that DISPLAYS state and never invites the user to set it instructs no
    // MCP-only step, so std-34 owes no handoff — and adding one would wrongly imply
    // the user has a job to do here.
    for (const { path, code } of uiCodeFiles()) {
      expect(code, `${path} must not name supersede_spec in UI code`).not.toContain(
        'supersede_spec',
      );
    }
  });

  it('no on-screen copy suggests the USER can mark a Spec superseded', () => {
    tagAc(AC(14));
    const { container } = render(
      <MemoryRouter>
        <SupersededByBanner successorHandle="spec-510" note="absorbed" />
      </MemoryRouter>,
    );
    const text = (container.textContent ?? '').toLowerCase();
    // No imperative inviting the user to act on supersession.
    expect(text).not.toMatch(/mark (this )?(as )?superseded/);
    expect(text).not.toMatch(/click .* to supersede/);
    expect(text).not.toMatch(/set .* superseded/);
    // And no MCP vocabulary leaking onto a human surface (std-34 cl-3).
    expect(text).not.toContain('mcp');
    expect(text).not.toContain('get_information');
    expect(text).not.toContain('coding agent');
  });
});
