import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { ThemeProvider } from './ThemeContext';
import { SearchTrigger, searchKeycapLabel, type SearchTriggerVariant } from './SearchTrigger';

// spec-192 t-2: the shared SearchTrigger button. dec-3 fixes that it is a button
// (never an inline input — ac-12) carrying a platform-aware keycap (ac-13).

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-192/acs/ac-${n}`;

function renderTrigger(variant: SearchTriggerVariant) {
  return render(
    <ThemeProvider>
      <SearchTrigger variant={variant} />
    </ThemeProvider>,
  );
}

// Stub navigator.platform for the OS-branch test, then restore it.
function withPlatform(platform: string, fn: () => void) {
  const desc = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    if (desc) Object.defineProperty(navigator, 'platform', desc);
  }
}

describe('spec-192 t-2: SearchTrigger', () => {
  it('renders as a <button>, never an inline input (ac-12)', () => {
    tagAc(AC(12));

    tagAc(AC(3)); // scope ac-3: the trigger is a button, never an inline search input
    const { container, unmount } = renderTrigger('spec-board');
    const board = screen.getByTestId('search-palette-trigger-board');
    expect(board.tagName).toBe('BUTTON');
    expect(container.querySelector('input')).toBeNull();
    unmount();

    const { container: c2 } = renderTrigger('doc-header');
    const header = screen.getByTestId('search-palette-trigger-header');
    expect(header.tagName).toBe('BUTTON');
    expect(c2.querySelector('input')).toBeNull();
  });

  it('keycap label is OS-derived — ⌘K on Apple platforms, Ctrl K elsewhere (ac-13)', () => {
    tagAc(AC(13));
    tagAc(AC(5)); // scope ac-5: the keycap reflects the user's OS
    // Apple platforms → ⌘K (the OS check also matches iPhone/iPad).
    withPlatform('MacIntel', () => expect(searchKeycapLabel()).toBe('⌘K'));
    withPlatform('iPhone', () => expect(searchKeycapLabel()).toBe('⌘K'));
    // Everything else → Ctrl K.
    withPlatform('Win32', () => expect(searchKeycapLabel()).toBe('Ctrl K'));
    withPlatform('Linux x86_64', () => expect(searchKeycapLabel()).toBe('Ctrl K'));
  });

  it('renders the derived keycap label inside the button', () => {
    withPlatform('MacIntel', () => {
      renderTrigger('spec-board');
      expect(screen.getByTestId('search-palette-trigger-board')).toHaveTextContent('⌘K');
    });
  });
});
