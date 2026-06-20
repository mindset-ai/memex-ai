// spec-308 — the Memex keys page widens to max-w-5xl (dec-1) so the 6-column
// emission-keys table stops wrapping. ac-5: both render paths use max-w-5xl.
// (ac-6 — the intro prose stays at a readable measure — lives in
// EmissionKeysSection.spec-308.test.tsx, where the real component renders.)

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_5 = 'mindset-prod/memex-building-itself/specs/spec-308/acs/ac-5';
// Scope ACs verified by the same page-level assertions:
const AC_1 = 'mindset-prod/memex-building-itself/specs/spec-308/acs/ac-1'; // page uses available width
const AC_4 = 'mindset-prod/memex-building-itself/specs/spec-308/acs/ac-4'; // read-only notice still renders

let mockCanWrite = true;
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: mockCanWrite }),
}));

// Stub the keys tool for the page-level layout test (ac-5) — no network.
vi.mock('../components/EmissionKeysSection', () => ({
  EmissionKeysSection: () => <div data-testid="emission-keys-section">keys tool</div>,
}));

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

describe('MemexKeys page width (spec-308 ac-5)', () => {
  it('uses max-w-5xl (not max-w-2xl) for a writing member', () => {
    tagAc(AC_5);
    tagAc(AC_1); // scope: page uses the available horizontal width
    mockCanWrite = true;
    const { container } = renderPage();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-w-5xl');
    expect(root.className).not.toContain('max-w-2xl');
    // The key tool still renders on the writing-member path (behaviour intact).
    expect(screen.getByTestId('emission-keys-section')).toBeInTheDocument();
  });

  it('uses max-w-5xl on the read-only path and still renders the member notice', () => {
    tagAc(AC_5);
    tagAc(AC_4); // scope: read-only notice state remains correctly rendered
    mockCanWrite = false;
    const { container } = renderPage();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-w-5xl');
    expect(root.className).not.toContain('max-w-2xl');
    // The non-member notice still shows and the key tool stays hidden.
    expect(
      screen.getByText(/need to be a member of this Memex to manage its emission keys/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('emission-keys-section')).not.toBeInTheDocument();
  });
});
