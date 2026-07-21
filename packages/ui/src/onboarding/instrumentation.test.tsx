import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-502 t-6:
//   ac-10 — each wizard step emits a usage event on the metered path (std-35);
//           at minimum reached-connect (the head fired here is explore_viewed).
//   ac-5  — the funnel is instrumented so reached-connect → connected is queryable.
const AC_EVENTS = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-10';
const AC_FUNNEL = 'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-5';

// Mock the telemetry hook so we can assert what the companion emits (track()
// itself no-ops without a tenant, so we intercept it here).
const track = vi.fn();
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track, optedOut: false, setOptOut: vi.fn() }),
}));

// Import AFTER the mock is registered.
import { ExploreCompanion } from './ExploreCompanion';

const NS = '/mindset-prod/memex-building-itself';

function renderAt(path: string, props: { onCreate?: () => void; memexId?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ExploreCompanion onCreate={props.onCreate ?? (() => {})} memexId={props.memexId} />
    </MemoryRouter>,
  );
}

describe('spec-502 ac-5/ac-10: wizard funnel instrumentation', () => {
  beforeEach(() => track.mockClear());

  it('emits wizard.explore_viewed once when the companion appears (funnel head)', () => {
    tagAc(AC_EVENTS);
    tagAc(AC_FUNNEL);
    renderAt(`${NS}/trails`, { memexId: 'mx-123' });
    const viewed = track.mock.calls.filter((c) => c[0] === 'wizard.explore_viewed');
    expect(viewed).toHaveLength(1);
    expect(viewed[0][1]).toEqual({ memexId: 'mx-123' });
  });

  it('emits wizard.create_cta_clicked when the CTA is clicked', () => {
    tagAc(AC_EVENTS);
    const onCreate = vi.fn();
    renderAt(`${NS}/specs/spec-1`, { onCreate });
    fireEvent.click(screen.getByTestId('create-your-own-memex-cta'));
    expect(track).toHaveBeenCalledWith('wizard.create_cta_clicked');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
