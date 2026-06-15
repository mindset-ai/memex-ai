import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// spec-290 (dec-1 / ac-3) — the v4 breaking utility renames must be fully
// reconciled: no v3-scale or removed utility may survive in a className / @apply.
// v4 SILENTLY ignores an unknown utility (no build error), so a stray v3 class is
// an invisible visual regression — this guard is the safety net the build can't be.
const AC3 = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-3';

const SRC = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

/** Pull the token lists out of className="…", className={`…`}, and @apply …; */
function classTokenStrings(src: string): string[] {
  const out: string[] = [];
  for (const re of [
    /className\s*=\s*"([^"]*)"/g,
    /className\s*=\s*\{`([^`]*)`\}/g,
    /class\s*=\s*"([^"]*)"/g,
    /@apply\s+([^;{}]*);/g,
  ]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** Bare v3 utilities renamed/rescaled in v4, + the removed opacity/flex forms. */
const DEPRECATED_EXACT = new Set(['rounded', 'shadow', 'blur', 'outline-none']);
const DEPRECATED_RE =
  /^(?:(?:bg|text|border|ring|divide|placeholder)-opacity-\d+|flex-(?:grow|shrink))$/;

/** Strip variant prefixes (hover:, dark:, focus-visible:, etc.) → base utility. */
const base = (tok: string) => tok.slice(tok.lastIndexOf(':') + 1);

describe('spec-290: v4 utility renames reconciled (ac-3)', () => {
  it('ac-3: no deprecated v3 utility class survives in any className/@apply', () => {
    tagAc(AC3);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith('tailwindRenames.spec-290.test.ts')) continue;
      for (const str of classTokenStrings(readFileSync(file, 'utf8'))) {
        // Drop ${…} interpolations, then tokenize on whitespace.
        for (const raw of str.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
          const tok = base(raw.trim());
          if (!tok) continue;
          if (DEPRECATED_EXACT.has(tok) || DEPRECATED_RE.test(tok)) {
            offenders.push(`${file.replace(SRC, 'src')}: "${tok}"`);
          }
        }
      }
    }
    expect(offenders, `deprecated v3 utilities found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
