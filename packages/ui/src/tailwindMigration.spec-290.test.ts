import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// spec-290 — locally-verifiable scope ACs for the v4 migration end-state.
// ac-2 (pixel parity) is verified by browser computed-style + screenshots, and
// ac-4's journey half by CI — neither emits from jsdom, so they're not tagged here.
const AC1 = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-1';
const AC5 = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-5';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(UI, 'package.json'), 'utf8'));
const dev = pkg.devDependencies ?? {};
const indexCss = readFileSync(join(UI, 'src/index.css'), 'utf8');
const viteConfig = readFileSync(join(UI, 'vite.config.ts'), 'utf8');

describe('spec-290: v4 migration end-state', () => {
  it('ac-1: the package is on Tailwind v4 with the v3 + PostCSS chain gone', () => {
    tagAc(AC1);
    expect(dev['tailwindcss']).toMatch(/^[\^~]?4\./);
    expect(indexCss).toMatch(/@import\s+['"]tailwindcss['"]/);
    expect(indexCss).not.toMatch(/@tailwind\s+(base|components|utilities)/);
    expect(existsSync(join(UI, 'tailwind.config.js'))).toBe(false);
    expect(dev).not.toHaveProperty('autoprefixer');
  });

  it('ac-5: config form (@theme) + pipeline (@tailwindcss/vite) settled & documented', () => {
    tagAc(AC5);
    // CSS-first config form, implemented as an @theme token layer…
    expect(indexCss).toMatch(/@theme\s*\{/);
    // …and documented (the design-token reference comment was updated to match).
    expect(indexCss).toMatch(/Design Tokens \(spec-290 dec-1/);
    expect(indexCss).toMatch(/TWO LAYERS/);
    // Build pipeline is the Vite plugin, not PostCSS.
    expect(viteConfig).toMatch(/@tailwindcss\/vite/);
    expect(dev).not.toHaveProperty('@tailwindcss/postcss');
  });
});
