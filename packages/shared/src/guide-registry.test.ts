// t-4 screen-element registry — structure + route mapping (dec-3 / ac-16).

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  resolveScreenKey,
  GUIDE_SCREENS,
  REGISTERED_SCREEN_KEYS,
  guideElementsForScreen,
  isKnownGuideElement,
  allGuideElementIds,
} from './guide-registry.js';

const AC16 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-16';

describe('resolveScreenKey (ac-16 route → screenKey)', () => {
  it('maps tenancy-scoped paths to the right screen, most-specific first', () => {
    expect(resolveScreenKey('/acme/team')).toBe('specs-list'); // index
    expect(resolveScreenKey('/acme/team/specs')).toBe('specs-list');
    expect(resolveScreenKey('/acme/team/specs/spec-12')).toBe('spec-detail');
    expect(resolveScreenKey('/acme/team/specs/spec-12/decisions/dec-1')).toBe('spec-detail');
    expect(resolveScreenKey('/acme/team/standards')).toBe('standards-list');
    expect(resolveScreenKey('/acme/team/standards/std-3')).toBe('standard-detail');
    expect(resolveScreenKey('/acme/team/drift')).toBe('drift-inbox');
    expect(resolveScreenKey('/acme/team/docs/doc-9')).toBe('document-detail');
    expect(resolveScreenKey('/acme/team/pulse')).toBe('pulse');
    expect(resolveScreenKey('/acme/team/settings')).toBe('memex-settings');
  });

  it('returns null for non-tenancy / unknown paths', () => {
    expect(resolveScreenKey('/')).toBeNull(); // no namespace/memex
    expect(resolveScreenKey('/acme')).toBeNull(); // namespace only
    expect(resolveScreenKey('/login')).toBeNull();
    expect(resolveScreenKey('/acme/team/totally-unknown-screen')).toBeNull();
  });

  it('tolerates trailing slashes', () => {
    expect(resolveScreenKey('/acme/team/specs/')).toBe('specs-list');
    expect(resolveScreenKey('/acme/team/standards/')).toBe('standards-list');
  });
});

describe('registry structure (ac-16 elements)', () => {
  it('seeds the onboarding-central screens with {id, description} elements', () => {
    expect(REGISTERED_SCREEN_KEYS).toEqual(
      expect.arrayContaining(['specs-list', 'spec-detail', 'standards-list']),
    );
    for (const key of REGISTERED_SCREEN_KEYS) {
      const els = guideElementsForScreen(key);
      expect(els.length).toBeGreaterThan(0);
      for (const el of els) {
        expect(el.id).toMatch(/^[a-z0-9-]+$/); // stable kebab-case id
        expect(el.description.length).toBeGreaterThan(0); // human description for the agent
      }
    }
  });

  it('has unique element ids within every screen', () => {
    for (const key of REGISTERED_SCREEN_KEYS) {
      const ids = guideElementsForScreen(key).map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('isKnownGuideElement gates by screen + id; allGuideElementIds lists every id', () => {
    expect(isKnownGuideElement('spec-detail', 'phase-pill')).toBe(true);
    expect(isKnownGuideElement('spec-detail', 'not-a-real-element')).toBe(false);
    expect(isKnownGuideElement('specs-list', 'phase-pill')).toBe(false); // wrong screen
    const all = allGuideElementIds();
    expect(all).toContain('phase-pill');
    expect(all).toContain('new-spec-button');
    expect(all.length).toBe(Object.values(GUIDE_SCREENS).reduce((n, s) => n + (s?.elements.length ?? 0), 0));
  });

  it('returns [] for a screen with no registered elements yet', () => {
    expect(guideElementsForScreen('insights')).toEqual([]);
  });

  it('verifies the registry mechanism', () => {
    tagAc(AC16);
  });
});
