import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { Skill } from './Skill';
import type { SkillView } from '../api/skills';

// spec-300 t-6 ac-12: a standard referenced by a skill (`[per std-N]`) renders as
// a clickable link to that standard's page.
const AC12 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-12';

const fetchSkillMock = vi.fn();
vi.mock('../api/skills', async () => {
  const actual = await vi.importActual<typeof import('../api/skills')>('../api/skills');
  return {
    ...actual,
    fetchSkill: (...a: unknown[]) => fetchSkillMock(...a),
    fetchSkillFile: vi.fn(),
  };
});

vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

function skillView(overrides: Partial<SkillView> = {}): SkillView {
  return {
    ref: 'acme/repo/skills/skill-1',
    handle: 'skill-1',
    name: 'PR reviewer',
    description: 'Reviews PRs for missing tests',
    capabilities: { codebaseAccess: true, codeEditing: false, externalTools: false },
    skillMd: '# Review checklist\n\nAlways follow [per std-9] when reviewing.\n',
    files: [],
    ...overrides,
  };
}

function renderAt(handle: string) {
  return render(
    <MemoryRouter initialEntries={[`/acme/repo/skills/${handle}`]}>
      <Routes>
        <Route path="/:namespace/:memex/skills/:id" element={<Skill />} />
        <Route path="/:namespace/:memex/standards/:id" element={<div>standard page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Skill detail', () => {
  it('renders a `[per std-N]` reference as a clickable link to the standard (ac-12)', async () => {
    tagAc(AC12);
    fetchSkillMock.mockResolvedValueOnce(skillView());

    renderAt('skill-1');

    const link = await screen.findByTestId('standard-ref-link');
    expect(link).toHaveTextContent('std-9');
    expect(link.tagName).toBe('A');
    // Path-based link into the Standards surface (tenant-prefixed in the browser;
    // jsdom has no tenant in window.location so the suffix is the stable part).
    expect(link.getAttribute('href')).toContain('/standards/std-9');
  });

  it('renders the SKILL.md body as markdown (ac-12 context)', async () => {
    tagAc(AC12);
    fetchSkillMock.mockResolvedValueOnce(skillView());

    renderAt('skill-1');

    // The `# Review checklist` heading is rendered from the markdown body.
    expect(await screen.findByRole('heading', { name: 'Review checklist' })).toBeInTheDocument();
  });

  it('lists auxiliary files and shows usage (ac-12 context)', async () => {
    tagAc(AC12);
    fetchSkillMock.mockResolvedValueOnce(
      skillView({
        files: [
          { path: 'templates/report.md', purpose: 'output template', contentType: 'text/markdown', size: 120 },
        ],
      }),
    );

    renderAt('skill-1');

    expect(await screen.findByTestId('skill-files')).toHaveTextContent('templates/report.md');
    expect(screen.getByTestId('skill-usage')).toHaveTextContent('acme/repo/skills/skill-1');
  });
});
