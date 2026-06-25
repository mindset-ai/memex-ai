// spec-222 t-11 (dec-4) — the CLIENT half of ac-16 / ac-5: "ElevenLabs and
// Anthropic credentials never appear in the bundle or any client-visible payload."
//
// The SERVER half (origin gate, rate limit, per-session cap, no key in route
// payloads) is verified server-side. This proves the shipped BUNDLE holds no
// provider secret AND makes no DIRECT provider call — every ElevenLabs/Anthropic
// call is server-proxied (the browser only ever talks to /guide/v1). A leaked key
// or a hard-coded api.elevenlabs.io in the bundle would be a public-surface breach.

import { describe, it, expect, beforeAll } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AC_16 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-16';
const AC_5 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-5';

const here = dirname(fileURLToPath(import.meta.url)); // packages/guide-sdk/src/bundle
const sdkRoot = resolve(here, '..', '..'); // packages/guide-sdk
const bundleDir = resolve(sdkRoot, 'dist-bundle');

let blobs: string[] = [];
beforeAll(() => {
  execSync('pnpm --filter @memex/guide-sdk build:bundle', { cwd: resolve(sdkRoot, '..', '..'), stdio: 'pipe' });
  blobs = readdirSync(bundleDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(resolve(bundleDir, f), 'utf8'));
  expect(blobs.length).toBeGreaterThan(0);
}, 120_000);

describe('spec-222 t-11: the bundle holds no provider secret + no direct provider call (ac-16, ac-5)', () => {
  it('no ElevenLabs / Anthropic credential appears anywhere in the built bundle', () => {
    tagAc(AC_16);
    tagAc(AC_5);
    const secretPatterns: RegExp[] = [
      /ELEVENLABS_API_KEY/,
      /xi-api-key/i,
      /ANTHROPIC_API_KEY/,
      /\bsk-ant-[a-z0-9-]+/i, // a real Anthropic key prefix
      /\bxi-[a-z0-9]{20,}/i, // an ElevenLabs key shape
    ];
    for (const blob of blobs) {
      for (const re of secretPatterns) {
        expect(re.test(blob), `bundle must not contain ${re}`).toBe(false);
      }
    }
  });

  it('the bundle makes NO direct provider call — all TTS/LLM traffic is server-proxied', () => {
    tagAc(AC_5);
    // The browser connects ONLY to our /guide/v1 backend; it never contacts the
    // providers directly (that is the whole point of the server proxy — the key
    // and the abuse controls live there).
    for (const blob of blobs) {
      expect(blob).not.toMatch(/api\.elevenlabs\.io/i);
      expect(blob).not.toMatch(/api\.anthropic\.com/i);
    }
  });
});
