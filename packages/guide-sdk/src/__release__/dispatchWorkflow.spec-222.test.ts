// spec-222 t-13 (dec-7) — verifies the cross-repo corpus-refresh workflow.
//
// The actual CI execution (WIF auth, Cloud SQL proxy, live DB import) is reviewed
// sign-off — it can't run in a unit test. What IS exercised here: the workflow is
// valid YAML and carries the load-bearing properties of ac-21 — a repository_dispatch
// trigger (not the public endpoint), privileged WIF auth, the real t-8 website-surface
// import command, and the bounded + non-gating + idempotent posture. (ac-21)

import { describe, it, expect, beforeAll } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AC_21 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-21';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const wfPath = resolve(repoRoot, '.github/workflows/guide-content-website-refresh.yml');

let yaml = '';
beforeAll(() => {
  expect(existsSync(wfPath)).toBe(true);
  yaml = readFileSync(wfPath, 'utf8');
});

describe('spec-222 t-13: cross-repo corpus refresh workflow (ac-21)', () => {
  it('is well-formed (workflow basics; no tab indentation)', () => {
    tagAc(AC_21);
    // Dependency-free YAML sanity: YAML forbids hard tabs for indentation, and a
    // GitHub workflow must carry these top-level keys + at least one job.
    expect(yaml).not.toMatch(/\t/); // no tabs → no YAML indentation errors
    expect(yaml).toMatch(/^name:\s/m);
    expect(yaml).toMatch(/^on:\s*$/m);
    expect(yaml).toMatch(/^jobs:\s*$/m);
    expect(yaml).toMatch(/^\s{2}refresh:\s*$/m); // the refresh job
    expect(yaml).toMatch(/^\s{4}steps:\s*$/m);
  });

  it('is triggered by a privileged repository_dispatch — NOT the public anonymous endpoint', () => {
    tagAc(AC_21);
    expect(yaml).toMatch(/repository_dispatch:/);
    expect(yaml).toMatch(/website-content-changed/);
    // Privileged auth (CI/WIF), exactly like deploy.yml.
    expect(yaml).toMatch(/google-github-actions\/auth@v2/);
    expect(yaml).toMatch(/workload_identity_provider/);
    // It must NOT call the public anonymous routes (dec-4) — it refreshes via the
    // privileged import script over the Cloud SQL proxy, not an HTTP hit on the endpoint.
    expect(yaml).not.toMatch(/\/guide\/v1\/(session|voice|chat)/);
    expect(yaml).not.toMatch(/curl[^\n]*guide/);
  });

  it('runs the real t-8 website-surface import, bounded + non-gating + idempotent', () => {
    tagAc(AC_21);
    expect(yaml).toMatch(/import-guide-content\.ts/);
    expect(yaml).toMatch(/--surface=memex-website/);
    expect(yaml).toMatch(/llms-full\.txt/);
    expect(yaml).toMatch(/timeout 600/); // bounded
    expect(yaml).toMatch(/\|\| echo/); // non-gating (a failure never wedges the refresh)
    expect(yaml.toLowerCase()).toMatch(/idempotent/); // documented re-trigger safety
    // Uses the Cloud SQL proxy against the live DB (std-26), like deploy.sh.
    expect(yaml).toMatch(/cloud-sql-proxy/);
  });
});
