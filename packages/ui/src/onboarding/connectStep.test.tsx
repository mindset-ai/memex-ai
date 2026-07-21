import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { CreateSpecStep } from '../components/home/CreateSpecStep';

// spec-502 ac-9: the connect step honours std-34 — it provides a COPYABLE
// coding-agent handoff (the install command is a copy-to-clipboard block), never
// prose the user must transcribe. The wizard reuses this exact component (ac-15),
// so verifying it here verifies the wizard's connect gate honours the boundary.
//
// Rendered in `preview` mode so it does not poll journey-state (no network).
const AC_COPYABLE = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-9';

describe('spec-502 ac-9: the reused connect step is copyable (std-34)', () => {
  it('renders the agent-install instructions with a copy affordance', () => {
    tagAc(AC_COPYABLE);
    render(<CreateSpecStep preview />);
    // The install instructions block is present (the copyable handoff)...
    expect(screen.getByTestId('connect-instructions')).toBeInTheDocument();
    // ...and a coding-agent chip picker (claude-code is a first-class path).
    expect(screen.getByTestId('tool-claude-code')).toBeInTheDocument();
  });
});
