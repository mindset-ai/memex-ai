// spec-529 (ac-13, dec-5) — this feature is fair-code core, and the file path is
// the licence marker in this repo, so the classification is checkable rather than
// merely stated.
//
// It also asserts the renderer stays ONE code path. Gating this behind a licence
// would split the reading experience of the core artifact — the same document
// showing live status to one reader and inert text to another, including on the
// public shared-document page an anonymous visitor sees.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagAc } from '@memex-ai-ac/vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every file this Spec added under the reference-pill directory. */
function specRefFiles(): string[] {
  return readdirSync(HERE).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
}

describe('spec-529 is fair-code core', () => {
  it('carries no Enterprise Edition marker in any filename or directory', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-13');
    // `.ee.` in a filename or `.ee` as a dirname IS the licence boundary here —
    // there is no build flag to check instead.
    expect(specRefFiles().filter((f) => f.includes('.ee.'))).toEqual([]);
    expect(HERE.split('/').filter((seg) => seg === '.ee')).toEqual([]);
  });

  it('branches on no licence, tier or entitlement anywhere in the renderer', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-13');
    const offenders: string[] = [];
    for (const f of specRefFiles()) {
      if (f.includes('.test.')) continue;
      const src = readFileSync(join(HERE, f), 'utf8');
      if (/isEnterprise|licence|license|entitl|tier|\bplan\b/i.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
