// spec-372 issue-16 — the terminal "Agents build in lockstep" build prompt + dynamic spec token.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { AgentsBuildStep } from './AgentsBuildStep';

const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

describe('AgentsBuildStep (spec-372 issue-16)', () => {
  it('keeps a build prompt ("Go build") and injects the provided spec token', () => {
    tagAc(AC372(44));
    render(<AgentsBuildStep specToken="spec-376" />);
    const prompt = screen.getByTestId('agents-build-prompt').textContent ?? '';
    expect(prompt).toMatch(/the plan for spec-376 is complete/);
    expect(prompt).toMatch(/Now build it\./);
    expect(prompt).toMatch(/Go build\./);
  });

  it('falls back to the placeholder when no token is provided', () => {
    render(<AgentsBuildStep />);
    expect(screen.getByTestId('agents-build-prompt').textContent).toMatch(
      /the plan for <insert a spec number of one of your specs> is complete/,
    );
  });
});
