import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { CreateSkillModal } from './CreateSkillModal';

// spec-300 t-6:
//   ac-21 — an agent-assisted authoring entry point (describe-in-plain-language).
const AC21 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-21';
// spec-300 t-14 (issue-4b):
//   ac-45 — switching tabs clears any stale create-error banner.
const AC45 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-45';
// spec-300 t-15 Increment 1:
//   ac-49 — the Describe-it tab wires the full describe→draft→validate→create
//           round-trip; the disabled "Coming soon" stub is removed.
const AC49 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-49';

const createSkillMock = vi.fn();
const draftSkillMock = vi.fn();
vi.mock('../../api/skills', async () => {
  const actual = await vi.importActual<typeof import('../../api/skills')>('../../api/skills');
  return {
    ...actual,
    createSkill: (...a: unknown[]) => createSkillMock(...a),
    draftSkill: (...a: unknown[]) => draftSkillMock(...a),
  };
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

    expect(screen.getByTestId('skill-describe-panel')).toBeInTheDocument();
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

  it('drafts a SKILL.md from a description, then creates it on confirm (ac-49, closes ac-21)', async () => {
    tagAc(AC49);
    const draftMd =
      '---\nname: pr-test-review\ndescription: Reviews a PR for missing tests.\n---\n# PR test review\n\nSteps.\n';
    draftSkillMock.mockResolvedValueOnce({
      skillMd: draftMd,
      name: 'pr-test-review',
      description: 'Reviews a PR for missing tests.',
      body: '# PR test review\n\nSteps.\n',
    });
    createSkillMock.mockResolvedValueOnce({ handle: 'skill-9' });
    const onClose = vi.fn();
    renderModal(onClose);

    fireEvent.click(screen.getByTestId('skill-mode-describe'));
    fireEvent.change(screen.getByTestId('skill-describe-input'), {
      target: { value: 'A skill that reviews a PR for missing tests.' },
    });
    fireEvent.click(screen.getByTestId('skill-draft-submit'));

    // The plain-language description is sent to the server draft turn.
    await waitFor(() => expect(draftSkillMock).toHaveBeenCalledTimes(1));
    expect(draftSkillMock.mock.calls[0][0]).toContain('reviews a PR');

    // The validated draft is shown for review in the editor.
    expect(await screen.findByTestId('skill-draft-review')).toBeInTheDocument();
    expect(screen.getByTestId('skill-md-editor')).toHaveValue(draftMd);

    // Confirm → the ordinary create path persists the drafted SKILL.md verbatim.
    fireEvent.click(screen.getByTestId('create-skill-submit'));
    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1));
    expect(createSkillMock.mock.calls[0][0].skillMd).toBe(draftMd);
    expect(navigateMock).toHaveBeenCalled();
  });

  it('replaced the disabled "Coming soon" stub with a real draft action (ac-49)', () => {
    tagAc(AC49);
    renderModal();
    fireEvent.click(screen.getByTestId('skill-mode-describe'));

    // The old permanently-disabled stub is gone.
    expect(screen.queryByTestId('skill-describe-stub')).not.toBeInTheDocument();

    // The draft button is disabled only while the description is empty — it enables
    // once there is text to draft from (not a coming-soon dead affordance).
    const draftBtn = screen.getByTestId('skill-draft-submit');
    expect(draftBtn).toBeDisabled();
    fireEvent.change(screen.getByTestId('skill-describe-input'), {
      target: { value: 'A skill that formats commit messages.' },
    });
    expect(draftBtn).toBeEnabled();
  });

  it('surfaces a draft failure inline (ac-49)', async () => {
    tagAc(AC49);
    draftSkillMock.mockRejectedValueOnce(new Error('Could not draft a spec-valid SKILL.md'));
    renderModal();

    fireEvent.click(screen.getByTestId('skill-mode-describe'));
    fireEvent.change(screen.getByTestId('skill-describe-input'), {
      target: { value: 'too vague' },
    });
    fireEvent.click(screen.getByTestId('skill-draft-submit'));

    expect(await screen.findByTestId('create-skill-error')).toHaveTextContent(
      /could not draft/i,
    );
  });

  it('clears a stale create-error banner when switching tabs (ac-45)', async () => {
    tagAc(AC45);
    createSkillMock.mockRejectedValueOnce(new Error('SKILL.md frontmatter is missing `name`'));
    renderModal();

    // Produce an error on the Write tab.
    fireEvent.click(screen.getByTestId('skill-mode-write'));
    fireEvent.change(screen.getByTestId('skill-md-editor'), {
      target: { value: 'no frontmatter' },
    });
    fireEvent.click(screen.getByTestId('create-skill-submit'));
    expect(await screen.findByTestId('create-skill-error')).toBeInTheDocument();

    // Switching to another tab (including Describe, whose action is disabled)
    // must clear the banner so it never reads as a fresh failure (issue-4b).
    fireEvent.click(screen.getByTestId('skill-mode-describe'));
    expect(screen.queryByTestId('create-skill-error')).not.toBeInTheDocument();

    // And back to Upload stays clean.
    fireEvent.click(screen.getByTestId('skill-mode-upload'));
    expect(screen.queryByTestId('create-skill-error')).not.toBeInTheDocument();
  });
});
