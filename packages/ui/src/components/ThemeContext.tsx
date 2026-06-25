import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

type Theme = 'dark' | 'light';

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

// spec-318 t-12 (ac-23): the desktop Flutter shell hosts this web app in an
// `flutter_inappwebview` and exposes a JS bridge — `callHandler(name, ...args)`.
// In a plain browser the bridge is undefined, so every emit is guarded.
declare global {
  interface Window {
    flutter_inappwebview?: {
      callHandler: (handlerName: string, ...args: unknown[]) => unknown;
    };
  }
}

// spec-318 t-12 (ac-23): tell the desktop shell the current theme + the RESOLVED
// surface colour so it can paint the native title bar / tab strip to match. The
// shell reads `--color-surface` (the page's background) via this push rather than
// peeking into the webview's CSS. Guarded: a no-op outside the desktop shell.
function emitTheme(mode: Theme): void {
  const bridge = window.flutter_inappwebview;
  if (!bridge) return;
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-surface')
    .trim();
  bridge.callHandler('setTheme', { mode, background });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('memex-theme');
    return (stored === 'light' || stored === 'dark') ? stored : 'dark';
  });

  useEffect(() => {
    localStorage.setItem('memex-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme === 'light');
    // spec-318 t-12 (ac-23): push the resolved theme to the desktop shell AFTER
    // the .dark/.light class flips, so getComputedStyle reads the NEW surface
    // colour. Runs on mount and on every switch; a no-op in a plain browser.
    emitTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

/**
 * Like useTheme but tolerant of a missing provider, defaulting to 'dark'
 * (the app default). For leaf components — charts, maps — that unit tests
 * render without the provider tree; inside the app the provider always exists.
 */
export function useThemeName(): Theme {
  return useContext(ThemeContext)?.theme ?? 'dark';
}
