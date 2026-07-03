import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { Skill } from './Skill';
import type { SkillView } from '../api/skills';

// spec-300 t-6 ac-12: a standard referenced by a skill (`[per std-N]`) renders as
// a clickable link to that standard's page.
const AC12 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-12';
// spec-300 t-16 (dec-24) — file management on the detail page.
const AC54 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-54'; // add files (scope)
const AC55 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-55'; // remove w/ confirm (scope)
const AC57 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-57'; // editSkill(files) + gating (impl)
const AC58 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-58'; // confirm dialog (impl)

const fetchSkillMock = vi.fn();
const editSkillMock = vi.fn();
vi.mock('../api/skills', async () => {
  const actual = await vi.importActual<typeof import('../api/skills')>('../api/skills');
  return {
    ...actual,
    fetchSkill: (...a: unknown[]) => fetchSkillMock(...a),
    fetchSkillFile: vi.fn(),
    editSkill: (...a: unknown[]) => editSkillMock(...a),
  };
});

// Control write access per test (Skill.tsx gates the add/remove affordances on it).
let canWrite = true;
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({
    canWrite,
    isAuthenticated: true,
    membership: null,
    isReadOnly: !canWrite,
    isVisitedReadOnly: false,
  }),
}));

// Stub the drag-drop panel so the add flow is deterministic (its own FileReader +
// staging is covered by AuxiliaryFilesPanel.test + the e2e). The stub stages one
// canned file when clicked, exercising Skill.tsx's handleAddFiles / editSkill wiring.
vi.mock('../components/skills/AuxiliaryFilesPanel', () => ({
  AuxiliaryFilesPanel: ({
    files,
    onChange,
    disabled,
  }: {
    files: ReadonlyArray<{ path: string }>;
    onChange: (f: ReadonlyArray<Record<string, unknown>>) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="aux-panel-stub">
      <button
        type="button"
        data-testid="mock-stage-file"
        disabled={disabled}
        onClick={() =>
          onChange([
            { path: 'notes/added.md', contentType: 'text/markdown', text: 'hi', size: 2, binary: false },
          ])
        }
      >
        stage
      </button>
      <span data-testid="mock-staged-count">{files.length}</span>
    </div>
  ),
}));

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
  canWrite = true;
  editSkillMock.mockResolvedValue(undefined);
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

  it('adds staged files to the skill via editSkill({files}) and reloads (ac-54, ac-57)', async () => {
    tagAc(AC54);
    tagAc(AC57);
    fetchSkillMock.mockResolvedValue(skillView({ files: [] }));
    renderAt('skill-1');

    // Write access → the add panel is present. Stage a file, then Save.
    await screen.findByTestId('skill-add-files');
    fireEvent.click(screen.getByTestId('mock-stage-file'));
    fireEvent.click(await screen.findByTestId('skill-add-files-save'));

    await waitFor(() => expect(editSkillMock).toHaveBeenCalledTimes(1));
    const [handleArg, inputArg] = editSkillMock.mock.calls[0];
    expect(handleArg).toBe('skill-1');
    expect(inputArg.files).toEqual([
      { path: 'notes/added.md', purpose: undefined, contentType: 'text/markdown', text: 'hi', contentBase64: undefined },
    ]);
    // The skill is re-fetched after the edit (mount + reload).
    await waitFor(() => expect(fetchSkillMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('removes a file only after a confirmation, via editSkill({removeFiles}) (ac-55, ac-58)', async () => {
    tagAc(AC55);
    tagAc(AC58);
    fetchSkillMock.mockResolvedValue(
      skillView({
        files: [
          { path: 'templates/report.md', purpose: null, contentType: 'text/markdown', size: 120 },
        ],
      }),
    );
    renderAt('skill-1');

    // Click the row's X — nothing is removed yet; a confirmation dialog appears.
    fireEvent.click(await screen.findByTestId('skill-file-remove'));
    expect(screen.getByTestId('remove-skill-file-dialog')).toBeInTheDocument();
    expect(editSkillMock).not.toHaveBeenCalled();

    // Confirm → the file is removed through the validated edit path, then reloaded.
    fireEvent.click(screen.getByTestId('remove-skill-file-confirm'));
    await waitFor(() => expect(editSkillMock).toHaveBeenCalledTimes(1));
    expect(editSkillMock.mock.calls[0][1]).toEqual({ removeFiles: ['templates/report.md'] });
    await waitFor(() =>
      expect(screen.queryByTestId('remove-skill-file-dialog')).not.toBeInTheDocument(),
    );
  });

  it('cancelling the remove confirmation mutates nothing (ac-55, ac-58)', async () => {
    tagAc(AC55);
    tagAc(AC58);
    fetchSkillMock.mockResolvedValue(
      skillView({
        files: [
          { path: 'templates/report.md', purpose: null, contentType: 'text/markdown', size: 120 },
        ],
      }),
    );
    renderAt('skill-1');

    fireEvent.click(await screen.findByTestId('skill-file-remove'));
    fireEvent.click(screen.getByTestId('remove-skill-file-cancel'));

    expect(screen.queryByTestId('remove-skill-file-dialog')).not.toBeInTheDocument();
    expect(editSkillMock).not.toHaveBeenCalled();
  });

  it('hides the add + remove affordances for a read-only viewer (ac-57)', async () => {
    tagAc(AC57);
    canWrite = false;
    fetchSkillMock.mockResolvedValue(
      skillView({
        files: [
          { path: 'templates/report.md', purpose: null, contentType: 'text/markdown', size: 120 },
        ],
      }),
    );
    renderAt('skill-1');

    // The file list still renders (read is fine) …
    expect(await screen.findByTestId('skill-files')).toHaveTextContent('templates/report.md');
    // … but there is no remove control and no add panel.
    expect(screen.queryByTestId('skill-file-remove')).not.toBeInTheDocument();
    expect(screen.queryByTestId('skill-add-files')).not.toBeInTheDocument();
  });
});
