// spec-201: single source for the Memex MCP endpoint URL shown in connect
// instructions. Mirrors the derivation that originated in CliInstallSection
// (spec-141): the MCP server is hosted on the same Cloud Run service as the API,
// so strip a trailing `/api` from VITE_API_URL to get the host, then append
// `/mcp`. In local dev (VITE_API_URL not an http URL) point at the local server.
//
// Kept as a pure function so the derivation is unit-testable per environment
// (int vs prod) without booting the app — see mcpUrl.test.ts (ac-18).

const LOCAL_BASE = 'http://localhost:8080';

export function deriveInstallBase(apiUrl: string | undefined): string {
  const url = apiUrl ?? '';
  return url.startsWith('http') ? url.replace(/\/api\/?$/, '') : LOCAL_BASE;
}

export function deriveMcpUrl(apiUrl: string | undefined): string {
  return `${deriveInstallBase(apiUrl)}/mcp`;
}

// Resolved-once values for the current environment.
export const installBase = deriveInstallBase(import.meta.env.VITE_API_URL);
export const mcpUrl = deriveMcpUrl(import.meta.env.VITE_API_URL);
