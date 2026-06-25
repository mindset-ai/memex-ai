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
// spec-206 t-4: the synced-walkthrough advance tool.
const AC206_7 = 'mindset-prod/memex-building-itself/specs/spec-206/acs/ac-7';

describe('guide toolset — no product-data tools (ac-28)', () => {
  it('contains exactly the UI/guide tools and nothing else', () => {
    // spec-206 added advance_demo, spec-211 added start_walkthrough — both pure UI
    // affordances (no tenant data).
    expect([...GUIDE_TOOL_NAMES].sort()).toEqual([
      'advance_demo',
      'highlight',
      'navigate',
      'search_guide',
      'start_walkthrough',
    ]);
  });

  it('exposes start_walkthrough and neutralises advance_demo so the guide never self-advances (spec-211 ac-15)', () => {
    const start = GUIDE_TOOLS.find((t) => t.name === 'start_walkthrough');
    expect(start).toBeDefined();
    expect(start!.description.toLowerCase()).toContain('accept');
    expect(start!.description.toLowerCase()).toContain('do not advance the board yourself');

    // advance_demo is kept on the rail but must NOT instruct the guide to call it
    // per phase (that was the burst); its description tells the guide NOT to call it.
    const advance = GUIDE_TOOLS.find((t) => t.name === 'advance_demo');
    expect(advance!.description.toLowerCase()).toContain('do not call this');
    tagAc('mindset-prod/memex-building-itself/specs/spec-211/acs/ac-15');
  });

  it('exposes advance_demo for the demo-specs walkthrough (spec-206 ac-7)', () => {
    const tool = GUIDE_TOOLS.find((t) => t.name === 'advance_demo');
    expect(tool).toBeDefined();
    expect(tool!.description.toLowerCase()).toContain('walkthrough');
    expect(tool!.input_schema.type).toBe('object');
    tagAc(AC206_7);
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
