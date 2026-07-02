// spec-300 t-15 (dec-23) — the skills agent's on-mount controller.
//
//   - the controller enters 'skills' mode on mount and leaves it (exitScopedMode)
//     on unmount;
//   - like the standards / issues agents (spec-389 dec-1) it opens with the shared
//     STATIC AgentIntro card, NOT an opening LLM turn — so it fires no opening turn;
//     the first LLM call waits for the user.

import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

// ac-46 (scope): a user can open an in-app agent on the Skills page in the shared
// shell and converse with it to author / curate skills.
const AC_SKILLS_SURFACE =
  'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-46';
// ac-52 (implementation): the Skills page mounts the shared ChatPanel via an
// OpeningSkillsController; ChatContext gains enter/exitSkillsMode.
const AC_SKILLS_MOUNT =
  'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-52';

const mockEnterSkillsMode = vi.fn();
const mockExitScopedMode = vi.fn();

vi.mock('../ChatContext', () => ({
  useChat: () => ({
    enterSkillsMode: mockEnterSkillsMode,
    exitScopedMode: mockExitScopedMode,
  }),
}));

import { OpeningSkillsController } from './OpeningSkillsController';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpeningSkillsController', () => {
  it('enters skills mode on mount and leaves it on unmount', () => {
    tagAc(AC_SKILLS_SURFACE);
    tagAc(AC_SKILLS_MOUNT);
    const { unmount } = render(<OpeningSkillsController />);
    expect(mockEnterSkillsMode).toHaveBeenCalledTimes(1);
    expect(mockExitScopedMode).not.toHaveBeenCalled();
    unmount();
    expect(mockExitScopedMode).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire an opening LLM turn on entry (static intro)', () => {
    tagAc(AC_SKILLS_MOUNT);
    // The controller only enters/leaves the scoped mode — no opening-turn hook is
    // consumed, guarding against a money-costing icebreaker being reintroduced.
    render(<OpeningSkillsController />);
    expect(mockEnterSkillsMode).toHaveBeenCalledTimes(1);
  });
});
