// spec-507 dec-3 — the five onboarding.video_* events SURVIVE the gate's removal.
//
// The page they fire from is still there (opt-in, from the account menu), so the
// names keep a live emitter and the historical Mixpanel series stays continuous
// instead of splitting at the deploy. What had to change is the prose: a description
// that says "first-run" would now be false, and "~85% of the v4 video" was already
// stale (the threshold is 75%, the cut is v6).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tagAc } from '@memex-ai-ac/vitest';
import { USAGE_EVENT_REGISTRY } from './usage-events-registry.js';

const AC_EVENTS_KEPT = 'mindset-prod/memex-building-itself/specs/spec-507/acs/ac-13';

const VIDEO_EVENTS = [
  'onboarding.video_started',
  'onboarding.video_completed',
  'onboarding.video_skipped',
  'onboarding.video_call_cta_shown',
  'onboarding.video_call_cta_clicked',
] as const;

const markdown = readFileSync(
  fileURLToPath(new URL('../EVENT-STANDARD.md', import.meta.url)),
  'utf8',
);
const byName = new Map(USAGE_EVENT_REGISTRY.map((e) => [e.name, e]));

describe('spec-507 ac-13: the video events stay registered, re-described', () => {
  it('keeps all five names in the registry as front-end events', () => {
    tagAc(AC_EVENTS_KEPT);
    for (const name of VIDEO_EVENTS) {
      const entry = byName.get(name);
      expect(entry, `${name} must stay registered`).toBeDefined();
      expect(entry!.source).toBe('frontend');
    }
  });

  it('drops the "first-run" framing from every description', () => {
    tagAc(AC_EVENTS_KEPT);
    for (const name of VIDEO_EVENTS) {
      expect(byName.get(name)!.description.toLowerCase()).not.toContain('first-run');
    }
  });

  it('drops the stale 85% / v4 reveal threshold', () => {
    tagAc(AC_EVENTS_KEPT);
    const shown = byName.get('onboarding.video_call_cta_shown')!.description;
    expect(shown).not.toContain('85%');
    expect(shown).not.toContain('v4 video');
    expect(shown).toContain('75%');
  });

  it('restates video_skipped as abandonment, not a declined interstitial', () => {
    tagAc(AC_EVENTS_KEPT);
    const skipped = byName.get('onboarding.video_skipped')!.description;
    expect(skipped).toMatch(/left the page before it ended/i);
    // The affordances it used to name no longer exist on the page.
    expect(skipped).not.toContain('Get-started');
    expect(skipped).not.toContain('× close');
  });

  it('mirrors the same corrections into EVENT-STANDARD.md (std-35 cl-3)', () => {
    tagAc(AC_EVENTS_KEPT);
    for (const name of VIDEO_EVENTS) {
      const line = markdown.split('\n').find((l) => l.startsWith(`- \`${name}\``));
      expect(line, `${name} must be documented`).toBeDefined();
      expect(line!.toLowerCase()).not.toContain('first-run');
    }
    expect(markdown).not.toContain('~85% of the v4 video');
  });
});
