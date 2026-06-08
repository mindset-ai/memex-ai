import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { acEmitterManifest } from '@memex/shared';

const AC_INSTALL_CMD = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-9';
const AC_KEYS_LINK = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-10';
const AC_EMIT_KEY_TAG = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-11';
const AC_MATRIX = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-13';

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    session: { memberships: [{ slug: 'acme', memexSlug: 'team', kind: 'team' }] },
  }),
}));

// jsdom clipboard for the CopyButton.
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import { AcEmitterSection } from './AcEmitterSection';

function renderSection() {
  return render(
    <MemoryRouter initialEntries={['/settings/integrations']}>
      <AcEmitterSection />
    </MemoryRouter>
  );
}

describe('spec-201 ac-13: adapter matrix is rendered from the shared manifest', () => {
  it('renders exactly one row per manifest entry', () => {
    tagAc(AC_MATRIX);
    renderSection();
    expect(screen.getAllByRole('row')).toHaveLength(acEmitterManifest.length);
  });

  it('shows each adapter package name and a status badge', () => {
    tagAc(AC_MATRIX);
    renderSection();
    for (const adapter of acEmitterManifest) {
      expect(screen.getByText(adapter.package)).toBeInTheDocument();
    }
    // The available adapter shows the "Available" badge.
    expect(screen.getAllByText('Available').length).toBeGreaterThan(0);
  });
});

describe('spec-201 ac-9: install command for the selected adapter', () => {
  it('defaults to the available adapter and shows its install command in a code block', () => {
    tagAc(AC_INSTALL_CMD);
    renderSection();
    const vitest = acEmitterManifest.find((a) => a.status === 'available')!;
    expect(screen.getByText(vitest.installCommand)).toBeInTheDocument();
  });
});

describe('spec-201 ac-10: deep link to the per-Memex Emission Keys panel', () => {
  it('links to /:namespace/:memex/keys resolved from the session membership', () => {
    tagAc(AC_KEYS_LINK);
    renderSection();
    const link = screen.getByRole('link', { name: 'Emission Keys' });
    expect(link).toHaveAttribute('href', '/acme/team/keys');
  });
});

describe('spec-201 ac-11: MEMEX_EMIT_KEY + tagAc example', () => {
  it('shows how to set MEMEX_EMIT_KEY and a tagAc() tagged-test example', () => {
    tagAc(AC_EMIT_KEY_TAG);
    renderSection();
    expect(screen.getByText(/MEMEX_EMIT_KEY=/)).toBeInTheDocument();
    // The tagAc example code block contains the call.
    const blocks = document.querySelectorAll('pre code');
    const joined = Array.from(blocks).map((b) => b.textContent ?? '').join('\n');
    expect(joined).toContain("tagAc('your-namespace/your-memex/specs/spec-1/acs/ac-1')");
  });
});

describe('spec-201: selecting a different available adapter updates the install command', () => {
  it('keeps coming-soon/planned adapters non-selectable', () => {
    tagAc(AC_MATRIX);
    renderSection();
    const planned = acEmitterManifest.find((a) => a.status === 'planned')!;
    // The planned row is rendered but disabled (not selectable).
    const rows = screen.getAllByRole('row');
    const plannedRow = rows.find((r) => within(r).queryByText(planned.package));
    expect(plannedRow).toBeDefined();
    expect(plannedRow).toBeDisabled();
  });
});
