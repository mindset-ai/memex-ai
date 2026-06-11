// Registry ↔ Standard parity check (spec-244 t-7 / dec-5).
//
// The anti-drift guarantee: the in-code registry (the machine contract) and
// EVENT-STANDARD.md (the human contract) must name EXACTLY the same set of events.
// Adding an event to one without the other fails this test — so a colleague (or
// their Claude Code) cannot land a half-documented event. When the public Memex
// Standard is authored post-production (dec-5), this check repoints at it.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { USAGE_EVENT_REGISTRY } from './usage-events-registry.js';

const AC = 'mindset-prod/memex-building-itself/specs/spec-244/acs';

// Pull every `event.name` mentioned in a bulleted line of the Standard.
function standardEventNames(markdown: string): Set<string> {
  const names = new Set<string>();
  const re = /^-\s+`([a-z_]+\.[a-z_]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) names.add(m[1]);
  return names;
}

describe('registry ↔ EVENT-STANDARD.md parity (ac-16 / ac-10)', () => {
  const markdown = readFileSync(
    fileURLToPath(new URL('../EVENT-STANDARD.md', import.meta.url)),
    'utf8',
  );
  const standard = standardEventNames(markdown);
  const registry = new Set(USAGE_EVENT_REGISTRY.map((e) => e.name));

  it('every registry event is documented in the Standard', () => {
    tagAc(`${AC}/ac-16`);
    const undocumented = [...registry].filter((n) => !standard.has(n));
    expect(undocumented, `registry events missing from EVENT-STANDARD.md: ${undocumented.join(', ')}`).toEqual(
      [],
    );
  });

  it('every Standard event exists in the registry (no phantom docs)', () => {
    tagAc(`${AC}/ac-16`);
    tagAc(`${AC}/ac-10`);
    const phantom = [...standard].filter((n) => !registry.has(n));
    expect(phantom, `EVENT-STANDARD.md names events not in the registry: ${phantom.join(', ')}`).toEqual([]);
  });

  it('the parity check actually found events to compare (guards a broken parser)', () => {
    tagAc(`${AC}/ac-16`);
    expect(standard.size).toBeGreaterThanOrEqual(USAGE_EVENT_REGISTRY.length);
    expect(registry.size).toBeGreaterThan(0);
  });
});
