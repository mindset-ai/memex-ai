// spec-318 t-12 (ac-23): ThemeProvider emits setTheme(mode, background) to the
// desktop Flutter shell on mount and on every light/dark switch — and is a safe
// no-op in a plain browser where window.flutter_inappwebview is undefined.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { act } from 'react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from './ThemeContext';

function Toggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button onClick={toggleTheme} data-testid="toggle">
      {theme}
    </button>
  );
}

beforeEach(() => {
  localStorage.clear();
  // Give --color-surface a resolvable value so the emitted background is concrete.
  document.documentElement.style.setProperty('--color-surface', 'rgb(10, 20, 30)');
  delete (window as Record<string, unknown>).flutter_inappwebview;
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--color-surface');
  delete (window as Record<string, unknown>).flutter_inappwebview;
});

describe('ThemeProvider → setTheme emit', () => {
  it('emits setTheme on initial mount with the current mode + resolved background', () => {
    const callHandler = vi.fn();
    (window as Record<string, unknown>).flutter_inappwebview = { callHandler };

    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );

    expect(callHandler).toHaveBeenCalledWith('setTheme', {
      mode: 'dark', // app default
      background: 'rgb(10, 20, 30)',
    });
  });

  it('re-emits setTheme with the new mode when the theme is toggled', async () => {
    const callHandler = vi.fn();
    (window as Record<string, unknown>).flutter_inappwebview = { callHandler };
    const user = userEvent.setup();

    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );
    callHandler.mockClear();

    await user.click(screen.getByTestId('toggle'));

    expect(callHandler).toHaveBeenCalledWith('setTheme', {
      mode: 'light',
      background: 'rgb(10, 20, 30)',
    });
  });

  it('is a safe no-op (never throws) when flutter_inappwebview is undefined', () => {
    expect(() =>
      render(
        <ThemeProvider>
          <Toggle />
        </ThemeProvider>,
      ),
    ).not.toThrow();
  });
});
