import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// spec-290 (dec-2 / ac-9) — the build pipeline is Tailwind v4's Vite plugin, NOT
// the PostCSS + autoprefixer chain. This guard asserts the pipeline SHAPE so the
// PostCSS path can't silently creep back; the "vite build is green" half of ac-9
// is exercised by the build itself (and the std-28 / verify pass in t-7).
const AC9 = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-9';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const viteConfig = readFileSync(join(PKG_DIR, 'vite.config.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));
const dev = pkg.devDependencies ?? {};

describe('spec-290: Tailwind v4 build pipeline (Vite plugin, no PostCSS)', () => {
  it('ac-9: vite.config wires @tailwindcss/vite and there is no PostCSS chain', () => {
    tagAc(AC9);
    // The Vite plugin is imported and invoked in the plugins array.
    expect(viteConfig).toMatch(/import\s+tailwindcss\s+from\s+['"]@tailwindcss\/vite['"]/);
    expect(viteConfig).toMatch(/tailwindcss\(\)/);

    // The PostCSS pipeline is gone: no config file, no autoprefixer, no
    // @tailwindcss/postcss bridge, no stray postcss dep.
    expect(existsSync(join(PKG_DIR, 'postcss.config.js'))).toBe(false);
    expect(dev).not.toHaveProperty('autoprefixer');
    expect(dev).not.toHaveProperty('@tailwindcss/postcss');
    expect(dev).not.toHaveProperty('postcss');

    // …and we're on v4 with the Vite plugin pinned to the same major.
    expect(dev['@tailwindcss/vite']).toMatch(/^[\^~]?4\./);
    expect(dev['tailwindcss']).toMatch(/^[\^~]?4\./);
  });
});
