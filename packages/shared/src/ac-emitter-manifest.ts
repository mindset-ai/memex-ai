// spec-201 dec-3: the per-language AC-emitter adapter catalogue, single-sourced
// as committed plain data (mirrors tool-manifest.ts, std-16). The Integrations
// page renders this matrix; each adapter PR flips its own entry's `status`, and
// ac-emitter-manifest.test.ts guards it against drift. Dependency-free so it can
// be imported by both the UI and the server without dragging anything in.

export type AcEmitterStatus = 'available' | 'coming-soon' | 'planned';

export interface AcEmitterEntry {
  /** Language family, e.g. "TypeScript / JavaScript". */
  readonly language: string;
  /** Test framework the adapter targets, e.g. "Vitest". */
  readonly framework: string;
  /** Published (or reserved) package name. */
  readonly package: string;
  /** Copy-pasteable install command for the package. */
  readonly installCommand: string;
  /** Availability of the adapter. */
  readonly status: AcEmitterStatus;
  /** Where to read more (npm/PyPI/registry or docs). */
  readonly docsUrl: string;
}

export const AC_EMITTER_STATUSES: readonly AcEmitterStatus[] = [
  'available',
  'coming-soon',
  'planned',
];

// One row per adapter. Keep `vitest` first — it's the reference adapter (spec-89)
// and the only one shipped today. pytest is next (spec-128).
export const acEmitterManifest: readonly AcEmitterEntry[] = [
  {
    language: 'TypeScript / JavaScript',
    framework: 'Vitest',
    package: '@memex-ai-ac/vitest',
    installCommand: 'npm install --save-dev @memex-ai-ac/vitest',
    status: 'available',
    docsUrl: 'https://www.npmjs.com/package/@memex-ai-ac/vitest',
  },
  {
    language: 'Python',
    framework: 'pytest',
    package: 'memex-ai-ac-pytest',
    installCommand: 'pip install --upgrade memex-ai-ac-pytest',
    status: 'coming-soon',
    docsUrl: 'https://pypi.org/project/memex-ai-ac-pytest/',
  },
  {
    language: 'TypeScript / JavaScript',
    framework: 'Jest',
    package: '@memex-ai-ac/jest',
    installCommand: 'npm install --save-dev @memex-ai-ac/jest',
    status: 'planned',
    docsUrl: 'https://www.npmjs.com/package/@memex-ai-ac/jest',
  },
  {
    language: 'Go',
    framework: 'go test',
    package: 'github.com/mindset-ai/memex-ai-ac-go',
    installCommand: 'go get github.com/mindset-ai/memex-ai-ac-go',
    status: 'planned',
    docsUrl: 'https://pkg.go.dev/github.com/mindset-ai/memex-ai-ac-go',
  },
];
