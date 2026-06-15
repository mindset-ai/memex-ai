import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// spec-290 (dec-1 / ac-7) — the Tailwind v4 token layer is CSS-first and must
// preserve the channel↔token split that AVOIDS the `--color-*` namespace
// collision the v3→v4 auto-migration produced (a token `--color-x` whose value
// resolves to `var(--color-x)` — its own raw channel store — yielding a
// bare-channel/invalid base utility). This test is the build-side guard: it
// asserts the SOURCE invariant that guarantees every base colour utility
// resolves to a valid colour in both themes.
const AC7 = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-7';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(SRC_DIR, 'index.css'), 'utf8');

/** Body of the `@theme { … }` block. */
function themeBlock(): string {
  const m = indexCss.match(/@theme\s*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error('no @theme block in index.css');
  return m[1];
}

/** Body of a top-level `.dark {…}` / `.light {…}` rule (first match = token block). */
function classBlock(theme: 'dark' | 'light'): string {
  const m = indexCss.match(new RegExp(`\\.${theme}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`no .${theme} block in index.css`);
  return m[1];
}

/** All `--color-<name>: <value>;` declarations in a block. */
function colorDecls(block: string): Array<{ name: string; value: string }> {
  return [...block.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map((m) => ({
    name: m[1],
    value: m[2].trim(),
  }));
}

describe('spec-290: v4 @theme token layer (anti-collision guard)', () => {
  const theme = themeBlock();
  const tokens = colorDecls(theme);

  it('ac-7: every @theme token maps to a --ch-* channel and is never self-referential', () => {
    tagAc(AC7);
    expect(tokens.length).toBeGreaterThan(40); // the full custom palette is present

    for (const { name, value } of tokens) {
      // No token resolves to its own name (the collision the upgrade tool produced).
      expect(value, `--color-${name} is self-referential`).not.toContain(
        `var(--color-${name})`,
      );
      // Every token reads from a channel in the dedicated --ch-* namespace,
      // either alpha-capable `rgb(var(--ch-…))` or baked `var(--ch-…)`.
      expect(value, `--color-${name} must reference a --ch-* channel`).toMatch(
        /^(rgb\(var\(--ch-[\w-]+\)\)|var\(--ch-[\w-]+\))$/,
      );
    }
  });

  it('ac-7: the .dark/.light channel blocks keep channels OUT of the --color-* namespace', () => {
    tagAc(AC7);
    for (const t of ['dark', 'light'] as const) {
      const stray = colorDecls(classBlock(t))
        .map((d) => d.name)
        // --color-logo is a standalone var (no token, no collision) consumed by
        // the logo SVG — intentionally left in place.
        .filter((n) => n !== 'logo');
      expect(
        stray,
        `.${t} must not define --color-* channels (would collide with @theme); found: ${stray.join(', ')}`,
      ).toEqual([]);
    }
  });
});
