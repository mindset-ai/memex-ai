import { useThemeName } from './ThemeContext';
import { useSearch } from './SearchContext';

// spec-192 t-2 (dec-3 / ac-12 / ac-13): the shared search trigger button used by
// BOTH surfaces — the Specs board header (a contained recess pill) and the
// doc-page header (a borderless edge-bleed recess). It is ALWAYS a <button> that
// opens the palette via the shared open-state (SearchContext.openSearch); it is
// NEVER an inline input — search happens only inside the palette (the user's hard
// constraint). The keycap is platform-aware: ⌘K on macOS, Ctrl K elsewhere
// (App's listener already accepts both metaKey and ctrlKey, so this is label-only).

export type SearchTriggerVariant = 'spec-board' | 'doc-header';

// ⌘K on Apple platforms, Ctrl K everywhere else. Read at call time so a test can
// stub navigator before render. `userAgentData.platform` is preferred where
// present (navigator.platform is deprecated), with sensible fallbacks.
export function searchKeycapLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K';
}

function SearchIcon() {
  return (
    <svg
      className="w-4 h-4 flex-none"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 21l-4.35-4.35m1.6-5.4a7 7 0 11-14 0 7 7 0 0114 0z"
      />
    </svg>
  );
}

const TEST_IDS: Record<SearchTriggerVariant, string> = {
  'spec-board': 'search-palette-trigger-board',
  'doc-header': 'search-palette-trigger-header',
};

export function SearchTrigger({ variant }: { variant: SearchTriggerVariant }) {
  const search = useSearch();
  // useThemeName (not useTheme) is the provider-tolerant read: SearchTrigger is a
  // leaf in SpecList / DocPageHeader, and several existing unit tests mount those
  // WITHOUT a ThemeProvider. It defaults to 'dark' when no provider is present;
  // inside the app the provider always exists, so theme switching stays live.
  const isDark = useThemeName() === 'dark';
  const label = searchKeycapLabel();

  // Bespoke per-theme values from spec-192 s-6 (validated against the index.css
  // tokens). The recess starts at the page background (--color-page) and
  // gradients into a darker shade; the keycap is a small inset cap. These are the
  // only non-token values — everything else follows the theme tokens.
  const recessEnd = isDark ? '#121419' : '#e7ebf1';
  const recessStyle = {
    backgroundImage: `linear-gradient(to right, rgb(var(--color-page)) 0%, ${recessEnd} 100%)`,
  };
  const keycapStyle = isDark
    ? { backgroundColor: 'rgba(62,68,81,.55)', borderColor: '#4b525f', color: '#cbd5e1', borderBottomWidth: 2 }
    : { backgroundColor: '#f1f5f9', borderColor: '#cbd5e1', color: '#475569', borderBottomWidth: 2 };

  const common =
    'group inline-flex items-center gap-2 text-sm text-secondary transition-colors hover:text-primary focus-visible:outline-none focus-visible:text-primary';

  // doc-header: fills the bar height (self-stretch) and sits as its own flex
  // column at the far right of DocPageHeader, so the recess bleeds to the top/
  // bottom/right bar edges and never overlaps the Edit/Share/download/⋯ controls.
  // spec-board: a self-contained rounded recess pill, sized to the Button md
  // height (px-3 py-1.5) so it sits cleanly at the end of the actions row.
  const variantClass =
    variant === 'doc-header' ? 'self-stretch px-5' : 'rounded-lg px-3 py-1.5';

  return (
    <button
      type="button"
      data-testid={TEST_IDS[variant]}
      data-variant={variant}
      onClick={() => search?.openSearch()}
      aria-label="Search (open command palette)"
      title="Search"
      style={recessStyle}
      className={`${common} ${variantClass}`}
    >
      <SearchIcon />
      {/* Decorative shortcut hint: the button's aria-label ("Search (open
          command palette)") already carries the accessible name, so the keycap is
          aria-hidden to avoid a confusing "Command K" announcement. */}
      <kbd
        aria-hidden="true"
        style={keycapStyle}
        className="rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none"
      >
        {label}
      </kbd>
    </button>
  );
}
