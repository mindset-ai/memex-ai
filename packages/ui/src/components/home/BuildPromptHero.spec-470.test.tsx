// spec-470 t-1 / t-4 — the build-prompt hero surface (ac-11), the escape link
// (ac-3), and the activation-funnel emits (ac-12). NewSpecModal is stubbed to a
// sentinel so these tests never drag in the agent graph — the hero→dialog wiring
// is covered by NewSpecModal.spec-470.test.tsx (ac-7/ac-8).
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = 'mindset-prod/memex-building-itself/specs/spec-470/acs';

const trackMock = vi.fn();
vi.mock('../../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track: trackMock, optedOut: false, setOptOut: vi.fn() }),
}));

// Stub the modal — the hero test only cares that a submit reaches the emits and
// opens the dialog; the auto-send handoff itself is tested against NewSpecModal.
vi.mock('../NewSpecModal', () => ({
  NewSpecModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="new-spec-modal-open" /> : null,
}));

import { BuildPromptHero } from './BuildPromptHero';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="probe" data-path={loc.pathname} />;
}

function renderHero(specsPath: string | null = '/alice/personal/specs') {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route
          path="/home"
          element={<BuildPromptHero firstName="Alice" specsPath={specsPath} />}
        />
        <Route path="/alice/personal/specs" element={<LocationProbe />} />
        <Route path="/specs" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  trackMock.mockClear();
});

describe('BuildPromptHero (spec-470)', () => {
  it('ac-11: renders the hero copy, a labelled input, and Enter submits', () => {
    tagAc(`${AC}/ac-11`);
    renderHero();

    expect(screen.getByTestId('hero-eyebrow')).toHaveTextContent('Memex');
    expect(screen.getByTestId('hero-greeting')).toHaveTextContent('Hi Alice.');
    expect(screen.getByTestId('hero-headline')).toHaveTextContent('What do you want to build?');
    expect(screen.getByTestId('hero-sub')).toHaveTextContent(
      "Describe it in a sentence — I'll turn it into a spec.",
    );

    // Labelled (accessible name) input with a visible focus ring.
    const input = screen.getByLabelText('Describe what you want to build');
    expect(input).toBe(screen.getByTestId('hero-input'));
    expect(input.className).toContain('focus:ring-2');
    // Placeholder is one of the enticing cycling examples.
    expect(input.getAttribute('placeholder')).toMatch(/^A (CLI|Slack bot|dashboard)/);

    // Enter (no shift) submits → the dialog opens and the modal renders.
    fireEvent.change(input, { target: { value: 'A CLI that tidies my downloads' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('new-spec-modal-open')).toBeInTheDocument();
  });

  it('ac-11: the placeholder cycles over time', () => {
    tagAc(`${AC}/ac-11`);
    vi.useFakeTimers();
    try {
      renderHero();
      const input = screen.getByTestId('hero-input');
      const first = input.getAttribute('placeholder');
      act(() => {
        vi.advanceTimersByTime(3300);
      });
      const second = screen.getByTestId('hero-input').getAttribute('placeholder');
      expect(second).not.toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ac-3: the "Skip to my specs" link navigates to the Specs board', () => {
    tagAc(`${AC}/ac-3`);
    renderHero('/alice/personal/specs');
    fireEvent.click(screen.getByTestId('hero-skip'));
    expect(screen.getByTestId('probe').getAttribute('data-path')).toBe(
      '/alice/personal/specs',
    );
  });

  it('ac-3: with no resolvable board path the skip link falls back to /specs', () => {
    tagAc(`${AC}/ac-3`);
    renderHero(null);
    fireEvent.click(screen.getByTestId('hero-skip'));
    expect(screen.getByTestId('probe').getAttribute('data-path')).toBe('/specs');
  });

  it('ac-12: emits build_prompt_shown on mount and the funnel events on submit', () => {
    tagAc(`${AC}/ac-12`);
    renderHero();

    // Shown fires once on mount (the funnel denominator), with no content props.
    const shown = trackMock.mock.calls.filter((c) => c[0] === 'home.build_prompt_shown');
    expect(shown).toHaveLength(1);

    // Empty submit neither emits submitted nor opens the dialog (dec-4 guard).
    fireEvent.click(screen.getByTestId('hero-submit'));
    expect(trackMock.mock.calls.some((c) => c[0] === 'home.build_prompt_submitted')).toBe(false);
    expect(screen.queryByTestId('new-spec-modal-open')).not.toBeInTheDocument();

    // A real sentence fires submitted + spec.create_clicked{surface:'home_hero'}.
    fireEvent.change(screen.getByTestId('hero-input'), {
      target: { value: 'A Slack bot that summarises threads' },
    });
    fireEvent.click(screen.getByTestId('hero-submit'));

    expect(trackMock.mock.calls.some((c) => c[0] === 'home.build_prompt_submitted')).toBe(true);
    const createClicked = trackMock.mock.calls.find((c) => c[0] === 'spec.create_clicked');
    expect(createClicked?.[1]).toEqual({ surface: 'home_hero' });
  });
});

afterEach(() => {
  vi.useRealTimers();
});
