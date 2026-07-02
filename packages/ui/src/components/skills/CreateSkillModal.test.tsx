import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { CreateSkillModal } from './CreateSkillModal';

// spec-300 t-6:
//   ac-21 — an agent-assisted authoring entry point (describe-in-plain-language).
const AC21 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-21';

const createSkillMock = vi.fn();
vi.mock('../../api/skills', async () => {
  const actual = await vi.importActual<typeof import('../../api/skills')>('../../api/skills');
  return { ...actual, createSkill: (...a: unknown[]) => createSkillMock(...a) };
});

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

function renderModal(onClose = vi.fn()) {
  return render(
    <MemoryRouter>
      <CreateSkillModal onClose={onClose} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CreateSkillModal', () => {
  it('exposes an agent-assisted authoring entry point (ac-21)', () => {
    tagAc(AC21);
    renderModal();

    // The "Describe it" mode is a real, discoverable entry point.
    const describeTab = screen.getByTestId('skill-mode-describe');
    expect(describeTab).toBeInTheDocument();
    fireEvent.click(describeTab);

    expect(screen.getByTestId('skill-describe-stub')).toBeInTheDocument();
    expect(screen.getByTestId('skill-describe-input')).toBeInTheDocument();
  });

  it('offers upload, write, and describe modes (ac-21 context)', () => {
    tagAc(AC21);
    renderModal();
    expect(screen.getByTestId('skill-mode-upload')).toBeInTheDocument();
    expect(screen.getByTestId('skill-mode-write')).toBeInTheDocument();
    expect(screen.getByTestId('skill-mode-describe')).toBeInTheDocument();
  });

  it('creates a skill from the in-app editor with capability flags', async () => {
    tagAc(AC21);
    createSkillMock.mockResolvedValueOnce({ handle: 'skill-7' });
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.click(screen.getByTestId('skill-mode-write'));
    fireEvent.change(screen.getByTestId('skill-md-editor'), {
      target: { value: '---\nname: x\ndescription: y\n---\n# x\n' },
    });
    fireEvent.click(screen.getByTestId('capability-codebaseAccess'));
    fireEvent.click(screen.getByTestId('create-skill-submit'));

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1));
    const arg = createSkillMock.mock.calls[0][0];
    expect(arg.skillMd).toContain('name: x');
    expect(arg.capabilities.codebaseAccess).toBe(true);
    expect(navigateMock).toHaveBeenCalled();
  });

  it('surfaces a server validation error inline', async () => {
    tagAc(AC21);
    createSkillMock.mockRejectedValueOnce(new Error('SKILL.md frontmatter is missing `name`'));
    renderModal();

    fireEvent.click(screen.getByTestId('skill-mode-write'));
    fireEvent.change(screen.getByTestId('skill-md-editor'), {
      target: { value: 'no frontmatter' },
    });
    fireEvent.click(screen.getByTestId('create-skill-submit'));

    expect(await screen.findByTestId('create-skill-error')).toHaveTextContent(
      /frontmatter is missing/i,
    );
  });
});
