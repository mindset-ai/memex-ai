// Types for workspace-alloc.mjs (spec-512 dec-3).
//
// The implementation is deliberately a zero-dependency `.mjs` so the Makefile can
// shell out to it with no build step and no transpile, per dec-2 (the house
// pattern set by scripts/check-url-shape.mjs and scripts/ci/deploy-gate.mjs).
// This declaration exists so the TypeScript regression suite can import the pure
// cores under `noImplicitAny` without an escape hatch.

export interface WorkspacePorts {
  e2eApi: number;
  e2eUi: number;
  dev: number;
  devUi: number;
}

export interface E2eDbNames {
  database: string;
  template: string;
}

export interface E2eConfig {
  workspaceRoot: string;
  workspaceId: string;
  apiPort: number;
  uiPort: number;
  devPort: number;
  devUiPort: number;
  databaseUrl: string;
  templateUrl: string;
  databaseName: string;
  templateName: string;
  usingOverride: boolean;
}

export function workspaceHash(workspaceRoot: string): string;
export function derivePorts(workspaceRoot: string): WorkspacePorts;
export function deriveE2eDbNames(workspaceRoot: string): E2eDbNames;
export function withDatabase(baseUrl: string, databaseName: string): string;
export function resolveWorkspaceId(
  env?: Record<string, string | undefined>,
): string | null;
export function resolveE2eConfig(
  env?: Record<string, string | undefined>,
  workspaceRoot?: string,
): E2eConfig;
