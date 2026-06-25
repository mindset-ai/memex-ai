// spec-222 t-14 (dec-9) — verifies the release:sdk pipeline produces the full,
// provenance-stamped, vendorable bundle. (ac-24)
//
// The PR-open / GCS-serving halves of ac-24 are reviewed sign-off (they need the
// memex-website repo + gh auth + the marketing bucket — not exercisable in a unit
// test). What IS exercised here: the repeatable build → full dist/ (thin loader +
// hashed chunks) → provenance stamp recording the source memex-ai commit + version,
// and the serving contract (marketing bucket, NOT the app/SPA bucket).

import { describe, it, expect, beforeAll } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AC_24 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-24';

const here = dirname(fileURLToPath(import.meta.url)); // packages/guide-sdk/src/__release__
const repoRoot = resolve(here, '..', '..', '..', '..'); // worktree root
const releaseDir = resolve(repoRoot, 'release', 'guide-sdk');

beforeAll(() => {
  // Build the bundle once, then run the release step (no rebuild) — exercises the
  // real `release:sdk` artifact assembly + provenance stamp.
  execSync('pnpm --filter @memex/guide-sdk build:bundle', { cwd: repoRoot, stdio: 'pipe' });
  execSync('node scripts/release-sdk.mjs --skip-build', { cwd: repoRoot, stdio: 'pipe' });
}, 120_000);

describe('spec-222 t-14: release:sdk produces a provenance-stamped vendorable bundle (ac-24)', () => {
  it('emits the FULL dist — a thin loader entry plus hashed chunks', () => {
    tagAc(AC_24);
    expect(existsSync(releaseDir)).toBe(true);
    const files = readdirSync(releaseDir);
    expect(files).toContain('memex-guide.js'); // the thin loader entry
    expect(files.some((f) => /^engine-.*\.js$/.test(f))).toBe(true); // hashed lazy engine chunk
    expect(files).toContain('provenance.json');
  });

  it('stamps provenance with the source memex-ai commit + version', () => {
    tagAc(AC_24);
    const prov = JSON.parse(readFileSync(resolve(releaseDir, 'provenance.json'), 'utf8'));
    const head = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
    expect(prov.sourceCommit).toBe(head); // recorded so the website (can't rebuild) knows the origin
    expect(prov.sourceRepo).toBe('memex-ai');
    expect(prov.version).toMatch(/^\d+\.\d+\.\d+/); // the guide-sdk package version
    expect(prov.entry).toBe('memex-guide.js');
    // every emitted file is listed in the manifest
    const onDisk = readdirSync(releaseDir).filter((f) => f !== 'provenance.json').sort();
    expect([...prov.files].sort()).toEqual(onDisk);
  });

  it('records the serving contract: marketing bucket, same-origin, NOT the app/SPA bucket', () => {
    tagAc(AC_24);
    const prov = JSON.parse(readFileSync(resolve(releaseDir, 'provenance.json'), 'utf8'));
    expect(prov.servedFrom).toMatch(/memex-ai-prod-marketing/); // the marketing bucket
    expect(prov.servedFrom).toMatch(/www\.memex\.ai\/js/); // same-origin js/ path
    expect(prov.servedFrom).toMatch(/NOT memex-app-spa-backend/); // explicitly excludes the SPA bucket
    expect(prov.embed).toContain('type="module"'); // ES bundle (t-5) → module script tag
  });
});
