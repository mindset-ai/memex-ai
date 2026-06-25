// spec-372 — the v3 copy + interaction changes on the onboarding step components.
//   ac-7  — per-persona "With Memex we promise" copy (Builder/Designer/Product, verbatim).
//   ac-17 — step-2 agent prompts instruct create AND fully flesh out (not just create_doc).
//   ac-18 — "Copy a prompt for your agent" copies the doc-grounded eval prompt; docs link.
//   ac-19 — step-1 reframe copy + no trailing periods on step headers.
//   ac-4  — "Specs that match reality" shows the 4 product shots at the prompt width.
//   ac-6 / ac-15 — step-4 honest waiting copy + a non-pulsing indicator.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', async () => {
  const real = await vi.importActual<typeof import('../../api/journey')>('../../api/journey');
  return { ...real, fetchJourneyStateApi };
});

import { CreateSpecStep } from './CreateSpecStep';
import { SpecsMatchRealityStep } from './SpecsMatchRealityStep';
import { RoleTriangle, CENTERED_ROLE, personaLabel, personaPromise } from './RoleTriangle';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({
    milestones: {},
    currentStepId: 'create-spec',
    steps: [],
    preview: false,
    canPreview: false,
  });
});

describe('spec-372 — persona promise copy (ac-7)', () => {
  it('returns the v3 Builder/Designer/Product promise verbatim, keyed to the dominant vertex', () => {
    tagAc(AC(7));
    expect(personaPromise({ dev: 1, design: 0, pm: 0 })).toEqual({
      head: "Your coding agent can't drift off-spec or fake its way to done.",
      detail:
        'Every action it takes is anchored to the specification. If the codebase reveals a better approach, the spec is updated.',
    });
    expect(personaPromise({ dev: 0, design: 1, pm: 0 })).toEqual({
      head: 'The design you specified is the design that ships.',
      detail: 'What ships is checked against what you specified. Verified, not assumed.',
    });
    expect(personaPromise({ dev: 0, design: 0, pm: 1 })).toEqual({
      head: "Nothing gets built on a decision you haven't made.",
      detail:
        "The build can't start until you've resolved the gating decisions, and agents report progress into the board as they work — live, not typed up later.",
    });
  });
});

describe('spec-372 — v3 role triangle (ac-29, ac-2)', () => {
  it('ac-29 / ac-2: coloured vertices (Product #0482DC), the "drag the dot" hint, and an un-hyphenated generalist label', () => {
    tagAc(AC(29));
    tagAc(AC(2));
    render(<RoleTriangle value={CENTERED_ROLE} onChange={() => {}} />);
    expect(screen.getByTestId('role-vertex-dev').getAttribute('data-color')).toBe('#4FB78F');
    expect(screen.getByTestId('role-vertex-design').getAttribute('data-color')).toBe('#AC59C5');
    expect(screen.getByTestId('role-vertex-pm').getAttribute('data-color')).toBe('#0482DC');
    expect(screen.getByTestId('role-triangle-hint').textContent).toContain('Drag the dot to where you fit.');
    // the balanced (centred) persona reads "Full stack generalist" — no hyphen (v3).
    expect(personaLabel(CENTERED_ROLE)).toBe('Full stack generalist');
  });
});

describe('spec-372 — step-1 reframe + prompts (ac-17, ac-18, ac-19)', () => {
  it('ac-19: step-1 presents the reframed copy with no trailing period on the header', () => {
    tagAc(AC(19));
    const { container } = render(<CreateSpecStep preview />);
    const h2 = screen.getByText('Build exactly what you decided');
    expect(h2.tagName).toBe('H2');
    expect(h2.textContent?.trim().endsWith('.')).toBe(false);
    // spec-372 issue-5 — the "Memex" glossary tooltip was removed, so the subtitle is now
    // plain text; assert on the rendered text content.
    expect(container.textContent).toContain(
      'Get the full magic of Memex by connecting to the MCP and using it in your coding agent',
    );
    expect(screen.getByText('Connect to the Memex MCP')).toBeInTheDocument();
    expect(
      screen.getByText('Draft your first spec with your coding agent, or create it here in the app.'),
    ).toBeInTheDocument();
  });

  it('ac-17: the agent-method sample prompt instructs create AND fully flesh out a rich spec (not bare create_doc)', () => {
    tagAc(AC(17));
    render(<CreateSpecStep preview />);
    const prompt = within(screen.getByTestId('create-spec-prompt')).getByText(/Using the Memex MCP/);
    const text = prompt.textContent ?? '';
    // spec-372 issue-11 — the sample prompt is a rich PRD-style starting point: create + fully
    // flesh out, a rich purpose narrative ("not just a feature list"), and dedicated spec
    // sections — i.e. far more than a bare create_doc call.
    expect(text).toMatch(/create and fully flesh out/i);
    expect(text).toMatch(/not just a feature list/i);
    expect(text).toMatch(/Problem section/i);
  });

  it('ac-18: "Copy a prompt for your agent" copies the doc-grounded eval prompt; docs link points at the docs', async () => {
    tagAc(AC(18));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CreateSpecStep preview />);

    fireEvent.click(screen.getByTestId('copy-explore-prompt'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('Fetch and read the Memex documentation at https://www.memex.ai/docs');

    const docsLink = screen.getByTestId('mcp-docs-link') as HTMLAnchorElement;
    expect(docsLink.getAttribute('href')).toBe('https://www.memex.ai/docs#mcp-tools-reference');
  });
});

describe('spec-372 — specs-match-reality (ac-4, ac-6, ac-15)', () => {
  it('ac-4: shows the 4 product shots, each filling the prompt-container width', () => {
    tagAc(AC(4));
    render(<SpecsMatchRealityStep preview />);
    const outcomes = screen.getByTestId('specs-match-reality-outcomes');
    const imgs = within(outcomes).getAllByRole('img');
    expect(imgs).toHaveLength(4);
    // Each shot's dark frame fills the content column (w-full, no narrower max-w cap) so it
    // matches the prompt-container width above (change #4).
    for (const img of imgs) {
      const frame = img.parentElement as HTMLElement;
      expect(frame.className).toContain('w-full');
      expect(frame.className).not.toContain('max-w-xl');
    }
  });

  it('ac-6 / ac-15: the waiting status uses honest copy with a non-pulsing indicator', () => {
    tagAc(AC(6));
    tagAc(AC(15));
    render(<SpecsMatchRealityStep preview />);
    const status = screen.getByTestId('specs-match-reality-status');
    expect(status.textContent).toContain(
      'Waiting for your agent to ground the plan in your codebase — this advances the moment it does.',
    );
    expect(status.textContent).not.toMatch(/working the codebase/i);
    // The idle indicator must NOT pulse (dec-4 — no animate-pulse on the unmet state).
    expect(status.querySelector('.animate-pulse')).toBeNull();
  });

  it('spec-372 issue-15: the improve prompt injects the provided spec token (placeholder by default)', () => {
    const { rerender } = render(<SpecsMatchRealityStep preview specToken="spec-376" />);
    expect(screen.getByTestId('specs-match-reality-prompt').textContent).toMatch(/Improve spec-376, decisions/);
    rerender(<SpecsMatchRealityStep preview />);
    expect(screen.getByTestId('specs-match-reality-prompt').textContent).toMatch(
      /Improve <insert a spec number of one of your specs>, decisions/,
    );
  });
});
