import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
// `?raw` source imports (house pattern) — robust, non-flaky way to pin which
// surface owns the visibility control, without rendering or @types/node.
import memexSettingsSource from './MemexSettings.tsx?raw';
import orgSettingsTabSource from '../components/account/SettingsTab.tsx?raw';

// spec-141 ac-1: visibility stays per-Memex. It renders on the per-Memex
// Settings page and is NOT added to the org-level /org Settings tab.
const AC_VISIBILITY_PLACEMENT = 'mindset-prod/memex-building-itself/specs/spec-141/acs/ac-1';

describe('spec-141 ac-1: per-Memex visibility placement', () => {
  it('mounts the visibility editor on the per-Memex Settings page', () => {
    tagAc(AC_VISIBILITY_PLACEMENT);
    expect(memexSettingsSource).toMatch(/MemexVisibilitySettings/);
  });

  it('does NOT add the visibility editor to the org-level Settings tab', () => {
    tagAc(AC_VISIBILITY_PLACEMENT);
    expect(orgSettingsTabSource).not.toMatch(/MemexVisibilitySettings/);
  });
});
