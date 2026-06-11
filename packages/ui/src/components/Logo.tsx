import logoMarkup from '../assets/memex-logo-singlecol.svg?raw';

interface LogoProps {
  /** Sizes the wordmark — height drives it, width follows the aspect ratio.
   *  e.g. `h-5` in chrome, `h-8` on auth screens. */
  className?: string;
  /** Accessible name announced to screen readers. Defaults to "Memex". */
  label?: string;
  /** Hide from the a11y tree when an adjacent visible element already names it. */
  decorative?: boolean;
}

/**
 * The Memex wordmark — the single source of truth for the logo across the app
 * (spec-223 dec-2, ac-4).
 *
 * The SVG is inlined into the DOM (NOT an `<img>`) so its path fills resolve the
 * theme-aware `--color-logo` CSS variable and recolour with the `.light`/`.dark`
 * class on `document.documentElement` (dec-1). An `<img>` is opaque to CSS, which
 * is exactly why this is a deliberate, scoped exception to spec-197's
 * `<img>`-from-URL pattern — and why no `vite-plugin-svgr` is added (ac-8).
 *
 * Security: `dangerouslySetInnerHTML` is safe here because the markup is a
 * committed static asset bundled at build time — never user input, never fetched
 * (s-3). The inlined `<svg>` is sized by CSS (`h-full w-auto`), overriding the
 * asset's intrinsic 300×51.
 */
export function Logo({ className, label = 'Memex', decorative = false }: LogoProps) {
  return (
    <span
      data-testid="memex-logo"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      className={`inline-flex items-center [&>svg]:block [&>svg]:h-full [&>svg]:w-auto${
        className ? ` ${className}` : ''
      }`}
      dangerouslySetInnerHTML={{ __html: logoMarkup }}
    />
  );
}

export default Logo;
