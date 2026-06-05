import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-129 dec-8 (t-12) ac-18/ac-22: the member-visible "Memex keys" page. Any WRITING
// member of the current Memex can manage keys here (the EmissionKeysSection); a read-only
// visitor gets a notice instead. The role-scoping of what's listed/revocable is enforced
// server-side and covered by the API tests — here we assert the page-level write gate.
const AC_18 = 'mindset-prod/memex-building-itself/specs/spec-129/acs/ac-18';
const AC_22 = 'mindset-prod/memex-building-itself/specs/spec-129/acs/ac-22';

let mockCanWrite = true;
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: mockCanWrite }),
}));

// Stub the keys tool so this test stays a pure render-gate test (no network).
vi.mock('../components/EmissionKeysSection', () => ({
  EmissionKeysSection: () => <div data-testid="emission-keys-section">keys tool</div>,
}));

// PageHeader reads useAuth; stub it to its title so this test needs no AuthProvider.
vi.mock('../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import { MemexKeys } from './MemexKeys';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/acme/team/keys']}>
      <MemexKeys />
    </MemoryRouter>,
  );
}

describe('MemexKeys page (spec-129 dec-8)', () => {
  it('renders the emission-key tool for a writing member (ac-18)', () => {
    tagAc(AC_18);
    mockCanWrite = true;
    renderPage();
    expect(screen.getByTestId('emission-keys-section')).toBeInTheDocument();
    expect(screen.getByText('Memex keys')).toBeInTheDocument();
  });

  it('shows a member-required notice and hides the tool for a read-only viewer (ac-22)', () => {
    tagAc(AC_22);
    mockCanWrite = false;
    renderPage();
    expect(screen.queryByTestId('emission-keys-section')).not.toBeInTheDocument();
    expect(
      screen.getByText(/need to be a member of this Memex to manage its emission keys/i),
    ).toBeInTheDocument();
  });
});
