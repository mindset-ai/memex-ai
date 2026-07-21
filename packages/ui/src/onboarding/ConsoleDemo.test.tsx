import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { ConsoleDemo, DEFAULT_EXAMPLES } from './ConsoleDemo';

// spec-502: the console demo shows a concrete "create a spec for …" beat and
// honours prefers-reduced-motion. Its CTA ("Connect my agent") advances the wizard
// toward the connect step — part of the agent-connect spine (ac-2).
const AC_DEMO = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-2';

function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  // @ts-expect-error restore
  delete window.matchMedia;
});

describe('spec-502 ac-3: ConsoleDemo', () => {
  it('shows the full command immediately under reduced motion', () => {
    tagAc(AC_DEMO);
    setReducedMotion(true);
    render(<ConsoleDemo command="create a spec for search" onDone={() => {}} />);
    expect(screen.getByTestId('wizard-console-line').textContent).toContain(
      'create a spec for search',
    );
    // The forming-spec response is shown once the line is complete.
    expect(screen.getByTestId('wizard-console-response')).toBeInTheDocument();
  });

  it('continues to the next step when the CTA is clicked', () => {
    tagAc(AC_DEMO);
    setReducedMotion(true);
    const onDone = vi.fn();
    render(<ConsoleDemo onDone={onDone} />);
    fireEvent.click(screen.getByTestId('wizard-demo-continue'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('uses a portable default command (no memex-specific content)', () => {
    tagAc(AC_DEMO);
    setReducedMotion(true);
    render(<ConsoleDemo onDone={() => {}} />);
    const line = screen.getByTestId('wizard-console-line').textContent ?? '';
    expect(line).toContain('create a spec for');
    expect(line.toLowerCase()).not.toContain('building-itself');
    expect(line.toLowerCase()).not.toContain('mindset');
  });

  it('cycles through several examples via the Next/Prev controls', () => {
    tagAc(AC_DEMO);
    setReducedMotion(true); // deterministic: no typing, no auto-advance
    render(<ConsoleDemo onDone={() => {}} />);

    // Starts on example 1 (draft a spec).
    expect(screen.getByTestId('wizard-console-line').textContent).toContain(
      'create a spec for',
    );

    // Next → example 2 (resume a spec): pastes a spec URL, agent reads it.
    fireEvent.click(screen.getByTestId('wizard-demo-next'));
    expect(screen.getByTestId('wizard-console-line').textContent).toContain('/specs/spec-42');
    expect(screen.getByTestId('wizard-console-response').textContent?.toLowerCase()).toContain(
      'reading the spec',
    );

    // Prev wraps back to example 1.
    fireEvent.click(screen.getByTestId('wizard-demo-prev'));
    expect(screen.getByTestId('wizard-console-line').textContent).toContain('create a spec for');
  });

  it('collapses to a single static example when given a `command` (no controls)', () => {
    tagAc(AC_DEMO);
    setReducedMotion(true);
    render(<ConsoleDemo command="create a spec for search" onDone={() => {}} />);
    expect(screen.queryByTestId('wizard-demo-controls')).toBeNull();
  });

  it('every default example is portable (no memex-specific content)', () => {
    tagAc(AC_DEMO);
    for (const ex of DEFAULT_EXAMPLES) {
      const blob = `${ex.command} ${ex.response}`.toLowerCase();
      expect(blob).not.toContain('building-itself');
      expect(blob).not.toContain('mindset');
    }
  });
});
