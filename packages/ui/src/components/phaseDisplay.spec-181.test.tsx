import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { PhaseTabBar } from './PhaseTabBar';
import { phaseDisplayName } from '../utils/phaseDisplay';
import type { SpecStatus } from '../api/types';

// spec-181 ac-4 — the second pipeline phase renames `plan` → `specify` at every
// UI surface. The spec-164 display-name shim that mapped `plan` → "Specify"
// collapses: with the enum value now `specify`, "Specify" is pure
// capitalisation, so the shim is a plain capitaliser with NO phase-specific
// entries. The UI must still render "Specify" everywhere it did before — now
// driven by the `specify` enum value itself.

const AC_4 = 'mindset-prod/memex-building-itself/specs/spec-181/acs/ac-4';

describe('spec-181 ac-4 — the plan→specify phase rename collapses the display shim', () => {
  it('phaseDisplayName carries NO plan→"Specify" mapping — it is a plain capitaliser', () => {
    tagAc(AC_4);
    // "Specify" comes straight from capitalising the `specify` enum value.
    expect(phaseDisplayName('specify')).toBe('Specify');
    // The old shim special-cased `plan` → "Specify". That entry is gone: a stale
    // `plan` value now capitalises to "Plan", proving no plan→"Specify" mapping
    // survives.
    expect(phaseDisplayName('plan')).toBe('Plan');
    expect(phaseDisplayName('plan')).not.toBe('Specify');
  });

  it('PhaseTabBar renders "Specify" for the `specify` phase (data-tab = `specify`)', () => {
    tagAc(AC_4);
    render(
      <PhaseTabBar
        currentPhase={'specify' as SpecStatus}
        selectedTab="specify"
        onSelect={() => {}}
      />,
    );
    const specifyTab = screen.getByRole('tab', { name: /Specify/ });
    expect(specifyTab).toBeInTheDocument();
    expect(specifyTab).toHaveAttribute('data-tab', 'specify');
    // No stale "Plan" label leaks through anywhere on the bar.
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
  });
});
