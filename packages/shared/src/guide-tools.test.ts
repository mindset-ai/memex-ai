// t-5 guide toolset — the separation-of-concerns guard + navigation helpers
// (dec-4 / ac-26 / ac-28).

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  GUIDE_TOOLS,
  GUIDE_TOOL_NAMES,
  isNavigableScreen,
  screenKeyToPath,
} from './guide-tools.js';

const AC26 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-26';
const AC28 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-28';

describe('guide toolset — no product-data tools (ac-28)', () => {
  it('contains exactly highlight, navigate, search_guide and nothing else', () => {
    expect([...GUIDE_TOOL_NAMES].sort()).toEqual(['highlight', 'navigate', 'search_guide']);
  });

  it('contains NO product-data / tenant-content tool', () => {
    const forbidden = [
      'search_memex',
      'get_doc',
      'list_docs',
      'get_information',
      'get_ac',
      'list_acs',
      'get_issue',
      'list_tasks',
      'update_section',
      'create_doc',
    ];
    for (const name of forbidden) {
      expect(GUIDE_TOOL_NAMES.has(name)).toBe(false);
    }
    tagAc(AC28);
  });

  it('every tool has a name + description + object input_schema', () => {
    for (const t of GUIDE_TOOLS) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.input_schema.type).toBe('object');
    }
  });
});

describe('navigation targets (ac-26)', () => {
  it('list/landing screens are navigable and build a tenant-scoped path', () => {
    expect(screenKeyToPath('specs-list', { namespace: 'acme', memex: 'team' })).toBe('/acme/team/specs');
    expect(screenKeyToPath('standards-list', { namespace: 'acme', memex: 'team' })).toBe('/acme/team/standards');
    expect(screenKeyToPath('drift-inbox', { namespace: 'acme', memex: 'team' })).toBe('/acme/team/drift');
    expect(isNavigableScreen('specs-list')).toBe(true);
  });

  it('detail screens (need an entity id) and unknown keys are NOT navigable → null', () => {
    expect(screenKeyToPath('spec-detail', { namespace: 'acme', memex: 'team' })).toBeNull();
    expect(screenKeyToPath('standard-detail', { namespace: 'acme', memex: 'team' })).toBeNull();
    expect(screenKeyToPath('totally-unknown', { namespace: 'acme', memex: 'team' })).toBeNull();
    expect(isNavigableScreen('spec-detail')).toBe(false);
    tagAc(AC26);
  });
});
