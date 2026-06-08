import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { SearchProvider, useSearch } from './SearchContext';

// spec-192 t-1: the ⌘K open-state was lifted out of App.tsx's GlobalSearchHost
// into SearchProvider so the chrome (Specs-board + doc-page triggers) can open
// the one palette. These tests prove the lift preserved the shortcut and that a
// non-host component drives the same single palette instance (Scope ac-2).

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-192/acs/ac-${n}`;

const DIALOG = { name: 'Search this memex' } as const;

// A minimal chrome consumer — stands in for the real triggers, proving a
// component OTHER than the provider can drive the open-state via context.
function OpenButton() {
  const search = useSearch();
  return (
    <button data-testid="open-search" onClick={() => search?.openSearch()}>
      open
    </button>
  );
}

function renderProvider() {
  return render(
    <MemoryRouter>
      <SearchProvider>
        <OpenButton />
      </SearchProvider>
    </MemoryRouter>,
  );
}

describe('spec-192 t-1: lifted ⌘K open-state (SearchProvider)', () => {
  it('a non-host component opens the one palette via openSearch(), no second instance (ac-2)', async () => {
    tagAc(AC(2));
    renderProvider();
    expect(screen.queryByRole('dialog', DIALOG)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('open-search'));

    expect(await screen.findByRole('dialog', DIALOG)).toBeInTheDocument();
    // One palette, one source of truth — never a second dialog instance.
    expect(screen.getAllByRole('dialog', DIALOG)).toHaveLength(1);
  });

  it('⌘K still toggles the palette (spec-64 ac-16 preserved through the lift)', async () => {
    renderProvider();
    expect(screen.queryByRole('dialog', DIALOG)).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog', DIALOG)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', DIALOG)).not.toBeInTheDocument(),
    );
  });

  it('Ctrl K (non-mac modifier) also opens the palette', async () => {
    renderProvider();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', DIALOG)).toBeInTheDocument();
  });
});
