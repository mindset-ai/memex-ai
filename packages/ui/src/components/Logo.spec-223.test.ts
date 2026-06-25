import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';
import { Logo } from './Logo';
import logoSource from './Logo.tsx?raw';
// All render sites (ac-1) — imported as source so we assert the swap without rendering
// nine full pages (each drags routing/auth context).
import appShellSrc from './AppShell.tsx?raw';
import loginScreenSrc from './LoginScreen.tsx?raw';
import onboardingSrc from '../pages/Onboarding.tsx?raw';
import verifyEmailSrc from '../pages/VerifyEmail.tsx?raw';
import verifyEmailGateSrc from '../pages/VerifyEmailGate.tsx?raw';
import verifyDomainSrc from '../pages/VerifyDomain.tsx?raw';
import inviteAcceptSrc from '../pages/InviteAccept.tsx?raw';
import resetPasswordSrc from '../pages/ResetPassword.tsx?raw';
import sharedDocumentSrc from '../pages/SharedDocument.tsx?raw';
// Assert the static asset + theme tokens directly, no render needed. The actual
// two-theme legibility is proven at runtime in t-4 (e2e); here we pin the
// asset/token contract.
// SVG via `?raw` (house pattern); index.css is read off disk because Vite's CSS
// pipeline intercepts `*.css?raw` imports and returns an empty string under vitest.
import logoSvg from '../assets/memex-logo-singlecol.svg?raw';

// vitest runs with cwd = packages/ui.
const indexCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

const AC_SVG_TOKEN_FILLS =
  'mindset-prod/memex-building-itself/specs/spec-223/acs/ac-5';
const AC_TOKEN_BOTH_THEMES =
  'mindset-prod/memex-building-itself/specs/spec-223/acs/ac-6';
const AC_INLINE_SVG =
  'mindset-prod/memex-building-itself/specs/spec-223/acs/ac-7';
const AC_NO_SVGR =
  'mindset-prod/memex-building-itself/specs/spec-223/acs/ac-8';
const AC_ALL_SITES =
  'mindset-prod/memex-building-itself/specs/spec-223/acs/ac-1';
const AC_SINGLE_ASSET =
  'mindset-prod/memex-building-itself/specs/spec-223/acs/ac-3';
const AC_SINGLE_SOURCE =
  'mindset-prod/memex-building-itself/specs/spec-223/acs/ac-4';

const renderSites: ReadonlyArray<readonly [string, string]> = [
  ['AppShell', appShellSrc],
  ['LoginScreen', loginScreenSrc],
  ['Onboarding', onboardingSrc],
  ['VerifyEmail', verifyEmailSrc],
  ['VerifyEmailGate', verifyEmailGateSrc],
  ['VerifyDomain', verifyDomainSrc],
  ['InviteAccept', inviteAcceptSrc],
  ['ResetPassword', resetPasswordSrc],
  ['SharedDocument', sharedDocumentSrc],
];

const uiPkg = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
const rootPkg = readFileSync(resolve(process.cwd(), '../../package.json'), 'utf8');

// Extract the body of a `.<name> { ... }` rule (theme blocks have no nested braces).
function themeBlock(css: string, name: string): string {
  const m = css.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
}

describe('spec-223 ac-5: logo SVG fills reference the theme token', () => {
  it('contains no literal #0E112B hex anywhere in the asset', () => {
    tagAc(AC_SVG_TOKEN_FILLS);
    expect(logoSvg).not.toMatch(/#0E112B/i);
  });

  it('gives every <path> a fill that references var(--color-logo)', () => {
    tagAc(AC_SVG_TOKEN_FILLS);
    const paths = logoSvg.match(/<path\b/g) ?? [];
    const tokenFills = logoSvg.match(/fill:\s*rgb\(var\(--color-logo\)\)/g) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    expect(tokenFills.length).toBe(paths.length);
  });
});

describe('spec-223 ac-6: --color-logo defined in both themes', () => {
  it('defines --color-logo in the .dark block', () => {
    tagAc(AC_TOKEN_BOTH_THEMES);
    expect(themeBlock(indexCss, 'dark')).toMatch(/--color-logo:\s*\d+\s+\d+\s+\d+/);
  });

  it('defines --color-logo in the .light block', () => {
    tagAc(AC_TOKEN_BOTH_THEMES);
    expect(themeBlock(indexCss, 'light')).toMatch(/--color-logo:\s*\d+\s+\d+\s+\d+/);
  });

  it('uses distinct per-theme values so the wordmark inverts between themes', () => {
    tagAc(AC_TOKEN_BOTH_THEMES);
    const dark = themeBlock(indexCss, 'dark').match(/--color-logo:\s*([\d\s]+?);/)?.[1].trim();
    const light = themeBlock(indexCss, 'light').match(/--color-logo:\s*([\d\s]+?);/)?.[1].trim();
    expect(dark).toBeTruthy();
    expect(light).toBeTruthy();
    expect(dark).not.toBe(light);
  });
});

describe('spec-223 ac-7: <Logo/> renders inline SVG, not <img>', () => {
  it('renders an inline <svg> element (the path fills can resolve the CSS var)', () => {
    tagAc(AC_INLINE_SVG);
    const { container } = render(createElement(Logo));
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('imports the asset via ?raw (the source of the inlined markup)', () => {
    tagAc(AC_INLINE_SVG);
    expect(logoSource).toMatch(/memex-logo-singlecol\.svg\?raw/);
    expect(logoSource).toMatch(/dangerouslySetInnerHTML/);
  });

  it('exposes an accessible name by default and can opt out as decorative', () => {
    tagAc(AC_INLINE_SVG);
    const named = render(createElement(Logo));
    expect(named.getByRole('img', { name: 'Memex' })).toBeTruthy();
    named.unmount();
    const decorative = render(createElement(Logo, { decorative: true }));
    expect(decorative.queryByRole('img')).toBeNull();
  });
});

describe('spec-223 ac-8: inline-SVG treatment is scoped — no SVGR added', () => {
  it('adds no vite-plugin-svgr / SVG-as-component dependency to packages/ui or the root', () => {
    tagAc(AC_NO_SVGR);
    expect(uiPkg).not.toMatch(/svgr/i);
    expect(rootPkg).not.toMatch(/svgr/i);
  });

  it('uses ?raw (string import), never the ?react / SVGR component form', () => {
    tagAc(AC_NO_SVGR);
    // dec-2: the scoped exception inlines via a raw string, not an SVG-as-component plugin.
    expect(logoSource).toMatch(/\.svg\?raw/);
    expect(logoSource).not.toMatch(/\.svg\?react/);
  });
});

describe('spec-223 ac-1: <Logo/> replaces the text wordmark at every site', () => {
  it.each(renderSites)('%s renders <Logo/> and imports it', (_name, src) => {
    tagAc(AC_ALL_SITES);
    expect(src).toMatch(/<Logo\b/);
    expect(src).toMatch(/import \{ Logo \}/);
  });

  it.each(renderSites)('%s has no hardcoded text-[#7b93b8] wordmark left', (_name, src) => {
    tagAc(AC_ALL_SITES);
    expect(src).not.toContain('7b93b8');
  });

  it('leaves no memex.ai text wordmark span in any render site', () => {
    tagAc(AC_ALL_SITES);
    for (const [name, src] of renderSites) {
      expect(src, `${name} still has a text wordmark`).not.toMatch(
        /(memex|Memex)<span/,
      );
    }
  });
});

describe('spec-223 ac-4: one shared, reusable logo component', () => {
  it('every render site imports the same single Logo component', () => {
    tagAc(AC_SINGLE_SOURCE);
    for (const [name, src] of renderSites) {
      expect(src, `${name} does not import the shared Logo`).toMatch(
        /import \{ Logo \} from ['"][^'"]*\/Logo['"]/,
      );
    }
  });

  it('the logo markup lives in exactly one place (the asset is imported once)', () => {
    tagAc(AC_SINGLE_SOURCE);
    // Only <Logo/> owns the raw SVG import — sites consume the component, not the asset.
    expect(logoSource).toMatch(/memex-logo-singlecol\.svg\?raw/);
    for (const [name, src] of renderSites) {
      expect(src, `${name} re-imports the raw asset instead of using <Logo/>`).not.toMatch(
        /memex-logo-singlecol\.svg/,
      );
    }
  });
});

describe('spec-223 ac-3: one committed asset serves both themes', () => {
  const assetsDir = resolve(process.cwd(), 'src/assets');

  it('ships a single logo SVG — no separate light/dark image files', () => {
    tagAc(AC_SINGLE_ASSET);
    const logoFiles = readdirSync(assetsDir).filter((f) => /logo/i.test(f));
    expect(logoFiles).toEqual(['memex-logo-singlecol.svg']);
    // Defensive: nothing themed-by-filename slipped in.
    expect(logoFiles.some((f) => /(dark|light)/i.test(f))).toBe(false);
  });

  it('drives per-theme colour through the token, not a baked-in hex', () => {
    tagAc(AC_SINGLE_ASSET);
    // The one asset carries the var; the two themes only differ in --color-logo.
    expect(logoSvg).toMatch(/rgb\(var\(--color-logo\)\)/);
    expect(logoSvg).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
