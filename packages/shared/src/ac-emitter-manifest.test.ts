import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  acEmitterManifest,
  AC_EMITTER_STATUSES,
  type AcEmitterEntry,
} from './ac-emitter-manifest';

const AC_MANIFEST_EXISTS = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-12';
const AC_MANIFEST_GUARD = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-14';

describe('spec-201 ac-12: AC-emitter manifest is plain data with the required shape', () => {
  it('exports a non-empty array of entries', () => {
    tagAc(AC_MANIFEST_EXISTS);
    expect(Array.isArray(acEmitterManifest)).toBe(true);
    expect(acEmitterManifest.length).toBeGreaterThan(0);
  });

  it('every entry carries language, framework, package, installCommand, status, docsUrl', () => {
    tagAc(AC_MANIFEST_EXISTS);
    for (const e of acEmitterManifest) {
      const keys: (keyof AcEmitterEntry)[] = [
        'language',
        'framework',
        'package',
        'installCommand',
        'status',
        'docsUrl',
      ];
      for (const k of keys) {
        expect(typeof e[k]).toBe('string');
        expect((e[k] as string).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('spec-201 ac-14: anti-drift guard on the manifest', () => {
  it('includes the Vitest adapter with status "available"', () => {
    tagAc(AC_MANIFEST_GUARD);
    const vitest = acEmitterManifest.find((e) => e.package === '@memex-ai-ac/vitest');
    expect(vitest).toBeDefined();
    expect(vitest?.status).toBe('available');
    expect(vitest?.installCommand).toContain('@memex-ai-ac/vitest');
  });

  it('constrains every entry status to the allowed enum', () => {
    tagAc(AC_MANIFEST_GUARD);
    for (const e of acEmitterManifest) {
      expect(AC_EMITTER_STATUSES).toContain(e.status);
    }
  });

  it('has no duplicate package names', () => {
    tagAc(AC_MANIFEST_GUARD);
    const pkgs = acEmitterManifest.map((e) => e.package);
    expect(new Set(pkgs).size).toBe(pkgs.length);
  });
});
