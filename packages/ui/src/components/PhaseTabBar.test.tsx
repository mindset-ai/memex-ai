import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { PhaseTabBar } from './PhaseTabBar';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-159/acs/ac-${n}`;

const onSelect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

function tab(name: string) {
  return screen
    .getAllByRole('tab')
    .find((t) => t.getAttribute('data-tab') === name)!;
}

describe('PhaseTabBar', () => {
  it('renders four tabs in a tablist (spec-258: pipeline now ends in Done)', () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="specify" selectedTab="specify" onSelect={onSelect} />);
    expect(screen.getByRole('tablist', { name: /Spec phase view/i })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(within(tab('specify')).getByText('Specify')).toBeInTheDocument();
    expect(within(tab('build')).getByText('Build')).toBeInTheDocument();
    expect(within(tab('verify')).getByText('Verify')).toBeInTheDocument();
    expect(within(tab('done')).getByText('Done')).toBeInTheDocument();
  });

  it('marks the phase-matching tab as current with a ● dot and its phase colour', () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="build" selectedTab="build" onSelect={onSelect} />);
    const buildTab = tab('build');
    expect(buildTab).toHaveAttribute('data-current', 'true');
    expect(buildTab).toHaveAttribute('aria-current', 'step');
    // build → dedicated phase blue token fill (spec-252).
    expect(buildTab.className).toContain('bg-phase-build-bg');
    // ● current-dot present only on the current tab.
    expect(buildTab.textContent).toContain('●');
    expect(tab('specify').textContent).not.toContain('●');
    expect(tab('specify')).not.toHaveAttribute('data-current');
  });

  it('uses the dedicated purple phase fill for the specify tab when current (spec-252)', () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="specify" selectedTab="specify" onSelect={onSelect} />);
    // spec-252 dec-1: specify is purple via its own token, NOT the shared
    // `warning` variant (which still colours open/review amber).
    expect(tab('specify').className).toContain('bg-phase-specify-bg');
    expect(tab('specify').className).not.toContain('bg-status-warning-bg');
  });

  it('uses the dedicated green phase fill for the verify tab when current (spec-252)', () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="verify" selectedTab="verify" onSelect={onSelect} />);
    expect(tab('verify').className).toContain('bg-phase-verify-bg');
  });

  it("renders a grey Draft pill as current for phase 'draft'; Specify is NOT current", () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="draft" selectedTab="specify" onSelect={onSelect} />);
    // The Draft pill carries the current treatment: grey fill + ● dot, outside
    // the browsable tablist (so it's not a 'tab' role).
    const draftPill = document.querySelector('[data-tab="draft"]')!;
    expect(draftPill).toBeInTheDocument();
    expect(draftPill).toHaveAttribute('data-current', 'true');
    expect(draftPill).toHaveAttribute('aria-current', 'step');
    expect(draftPill.className).toContain('bg-status-neutral-bg');
    expect(draftPill.textContent).toContain('●');
    expect(draftPill.textContent).toContain('Draft');
    // Specify no longer carries the current treatment in draft.
    expect(tab('specify')).not.toHaveAttribute('data-current');
    expect(tab('specify').textContent).not.toContain('●');
    expect(tab('build')).not.toHaveAttribute('data-current');
    expect(tab('verify')).not.toHaveAttribute('data-current');
    // The Draft pill is a status indicator, not the ✓ Done marker.
    expect(screen.queryByTestId('done-marker')).not.toBeInTheDocument();
  });

  it("clicking the Draft pill selects the Specify view (draft's home)", async () => {
    tagAc(AC(2));
    const user = userEvent.setup();
    render(<PhaseTabBar currentPhase="draft" selectedTab="specify" onSelect={onSelect} />);
    await user.click(document.querySelector('[data-tab="draft"]')! as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith('specify');
  });

  it('renders NO Draft pill for any non-draft phase', () => {
    tagAc(AC(2));
    for (const phase of ['specify', 'build', 'verify', 'done'] as const) {
      const { unmount } = render(
        <PhaseTabBar currentPhase={phase} selectedTab="specify" onSelect={onSelect} />,
      );
      expect(document.querySelector('[data-tab="draft"]')).toBeNull();
      unmount();
    }
  });

  it("spec-258: the old ✓ Done marker no longer renders, and no tab is current at phase 'done'", () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="done" selectedTab="verify" onSelect={onSelect} />);
    // The dead ✓ Done marker block is removed — the Done tab supersedes it.
    expect(screen.queryByTestId('done-marker')).not.toBeInTheDocument();
    // `done` makes no tab current (in practice the bar is hidden at done anyway).
    for (const name of ['specify', 'build', 'verify', 'done']) {
      expect(tab(name)).not.toHaveAttribute('data-current');
    }
  });

  it('reflects the selected tab via aria-selected and the underline accent', () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="specify" selectedTab="build" onSelect={onSelect} />);
    expect(tab('build')).toHaveAttribute('aria-selected', 'true');
    expect(tab('build')).toHaveAttribute('data-selected', 'true');
    expect(tab('specify')).toHaveAttribute('aria-selected', 'false');
  });

  // The underline renders ONLY when the selected tab differs from the current
  // one — when they coincide the pill alone carries the state (stacking both
  // reads as clutter; Barrie 2026-06-04).
  it('hides the underline when the selected tab IS the current tab', () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="specify" selectedTab="specify" onSelect={onSelect} />);
    expect(tab('specify')).toHaveAttribute('data-selected', 'true');
    expect(tab('specify').querySelector('.h-0\\.5')).toBeNull();
  });

  it('shows the underline on a selected tab that is NOT the current tab', () => {
    tagAc(AC(2));
    render(<PhaseTabBar currentPhase="specify" selectedTab="build" onSelect={onSelect} />);
    expect(tab('build').querySelector('.h-0\\.5')).not.toBeNull();
    expect(tab('specify').querySelector('.h-0\\.5')).toBeNull();
  });

  it('calls onSelect with the clicked tab', async () => {
    tagAc(AC(2));
    const user = userEvent.setup();
    render(<PhaseTabBar currentPhase="specify" selectedTab="specify" onSelect={onSelect} />);
    await user.click(tab('verify'));
    expect(onSelect).toHaveBeenCalledWith('verify');
  });

  it('supports ArrowRight keyboard navigation between tabs', async () => {
    tagAc(AC(2));
    const user = userEvent.setup();
    render(<PhaseTabBar currentPhase="specify" selectedTab="specify" onSelect={onSelect} />);
    tab('specify').focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('build');
  });

  // Dual state: the two visual treatments are independent. A Spec in `verify`
  // whose user is browsing the `build` view shows the current pill on verify AND
  // the selected accent on build at the same time.
  it('shows both treatments at once: currentPhase=verify + selectedTab=build', () => {
    tagAc(AC(2));
    tagAc(AC(15));
    render(<PhaseTabBar currentPhase="verify" selectedTab="build" onSelect={onSelect} />);

    // verify carries the CURRENT treatment (filled pill + dot) but is NOT selected.
    const verifyTab = tab('verify');
    expect(verifyTab).toHaveAttribute('data-current', 'true');
    expect(verifyTab.className).toContain('bg-phase-verify-bg');
    expect(verifyTab.textContent).toContain('●');
    expect(verifyTab).toHaveAttribute('aria-selected', 'false');

    // build carries the SELECTED treatment but is NOT current.
    const buildTab = tab('build');
    expect(buildTab).toHaveAttribute('data-selected', 'true');
    expect(buildTab).toHaveAttribute('aria-selected', 'true');
    expect(buildTab).not.toHaveAttribute('data-current');
    expect(buildTab.textContent).not.toContain('●');
  });

  it('lets a single tab carry both treatments (current and selected)', () => {
    tagAc(AC(15));
    render(<PhaseTabBar currentPhase="build" selectedTab="build" onSelect={onSelect} />);
    const buildTab = tab('build');
    expect(buildTab).toHaveAttribute('data-current', 'true');
    expect(buildTab).toHaveAttribute('data-selected', 'true');
    expect(buildTab.textContent).toContain('●');
  });
});

// spec-164 (scope ac-2) — arrow separators give the bar a left-to-right
// pipeline read without disturbing the tablist semantics.
describe('PhaseTabBar — flow arrows (spec-164)', () => {
  const AC_ARROWS = 'mindset-prod/memex-building-itself/specs/spec-164/acs/ac-2';

  it('renders exactly three aria-hidden arrows between the four tabs (spec-258)', () => {
    tagAc(AC_ARROWS);
    render(<PhaseTabBar currentPhase="specify" selectedTab="specify" onSelect={() => {}} />);
    const arrows = screen.getAllByTestId('phase-arrow');
    expect(arrows).toHaveLength(3);
    for (const a of arrows) expect(a).toHaveAttribute('aria-hidden', 'true');
    // The tabs themselves are still the tablist's tabs, in pipeline order.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('data-tab'))).toEqual([
      'specify',
      'build',
      'verify',
      'done',
    ]);
  });
});

// spec-258 — the Done tab completes the pipeline (ac-1) and is coloured with
// resting/selected treatment only, never the filled "current" pill (ac-7/dec-4).
describe('PhaseTabBar — Done tab (spec-258)', () => {
  const S258 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-258/acs/ac-${n}`;

  it('renders the Done tab last, completing Specify → Build → Verify → Done (ac-1)', () => {
    tagAc(S258(1));
    render(<PhaseTabBar currentPhase="verify" selectedTab="verify" onSelect={onSelect} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('data-tab'))).toEqual([
      'specify',
      'build',
      'verify',
      'done',
    ]);
    // Same arrow-separated treatment as the other tabs: an arrow precedes Done.
    expect(screen.getAllByTestId('phase-arrow')).toHaveLength(3);
  });

  it('never gives the Done tab a filled VARIANT_FILL pill across any phase (ac-7/dec-4)', () => {
    tagAc(S258(7));
    for (const phase of ['draft', 'specify', 'build', 'verify'] as const) {
      const { unmount } = render(
        <PhaseTabBar currentPhase={phase} selectedTab="specify" onSelect={onSelect} />,
      );
      const doneTab = tab('done');
      // Resting only when unselected: no status-* fill, no current dot, not current.
      expect(doneTab).not.toHaveAttribute('data-current');
      expect(doneTab.className).not.toContain('bg-status-success-bg');
      expect(doneTab.className).not.toMatch(/bg-status-\w+-bg/);
      expect(doneTab.textContent).not.toContain('●');
      unmount();
    }
  });

  it('wears only the underline-selected accent when the Done tab is selected (ac-7)', () => {
    tagAc(S258(7));
    render(<PhaseTabBar currentPhase="verify" selectedTab="done" onSelect={onSelect} />);
    const doneTab = tab('done');
    expect(doneTab).toHaveAttribute('aria-selected', 'true');
    expect(doneTab).not.toHaveAttribute('data-current');
    // Underline accent present; still no filled pill.
    expect(doneTab.querySelector('.h-0\\.5')).not.toBeNull();
    expect(doneTab.className).not.toMatch(/bg-status-\w+-bg/);
  });

  it('reaches and activates the Done tab via keyboard nav (ac-1)', async () => {
    tagAc(S258(1));
    const user = userEvent.setup();
    render(<PhaseTabBar currentPhase="verify" selectedTab="verify" onSelect={onSelect} />);
    tab('verify').focus();
    await user.keyboard('{ArrowRight}');
    expect(onSelect).toHaveBeenCalledWith('done');
    onSelect.mockClear();
    // End jumps to the last tab — now Done.
    await user.keyboard('{End}');
    expect(onSelect).toHaveBeenCalledWith('done');
  });
});
