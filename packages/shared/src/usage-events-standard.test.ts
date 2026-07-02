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
const AC324 = 'mindset-prod/memex-building-itself/specs/spec-324/acs';

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

  it('spec-324 registered its events with the right source (and added no per-step names)', () => {
    tagAc(`${AC324}/ac-11`);
    tagAc(`${AC324}/ac-1`); // scope: home_canvas.* + signup.form_viewed registered + documented
    tagAc(`${AC324}/ac-4`); // scope: no per-step duplication — outcomes stay backend, clicks reuse one name
    const byName = new Map(USAGE_EVENT_REGISTRY.map((e) => [e.name, e]));
    // Front-end-born signals (recorded via a route, not the bus).
    for (const n of ['home_canvas.step_shown', 'home_canvas.cta_clicked', 'signup.form_viewed']) {
      expect(byName.get(n), `${n} missing from registry`).toBeDefined();
      expect(byName.get(n)?.source).toBe('frontend');
      expect(standard.has(n)).toBe(true); // and documented
    }
    // The identity stitch is a direct-path back-end emission.
    expect(byName.get('identity.merged')?.source).toBe('backend');
    expect(standard.has('identity.merged')).toBe(true);
    // dec-2: the custom-step clicks reuse home_canvas.cta_clicked — NO per-step
    // event names like onboarding.connect_agent_clicked were introduced. (The
    // spec-444 welcome-video lifecycle events, onboarding.video_*, are a separate
    // surface — not per-step Home-journey click names — so they're excluded here.)
    const perStep = [...byName.keys()].filter(
      (n) => /^onboarding\./.test(n) && !/^onboarding\.video_/.test(n),
    );
    expect(perStep).toEqual([]);
  });
});
