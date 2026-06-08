import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { deriveInstallBase, deriveMcpUrl } from './mcpUrl';

const AC_ENV_DERIVED = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-18';

describe('spec-201 ac-18: MCP URL is derived from VITE_API_URL, not hardcoded', () => {
  it('strips a trailing /api from a deployed API URL', () => {
    tagAc(AC_ENV_DERIVED);
    expect(deriveInstallBase('https://int.memex.ai/api')).toBe('https://int.memex.ai');
    expect(deriveInstallBase('https://memex.ai/api/')).toBe('https://memex.ai');
  });

  it('appends /mcp to the derived host, per environment', () => {
    tagAc(AC_ENV_DERIVED);
    // int vs prod resolve to different hosts purely from the input — no hardcoded host.
    expect(deriveMcpUrl('https://int.memex.ai/api')).toBe('https://int.memex.ai/mcp');
    expect(deriveMcpUrl('https://memex.ai/api')).toBe('https://memex.ai/mcp');
  });

  it('falls back to the local server when VITE_API_URL is not an http URL', () => {
    tagAc(AC_ENV_DERIVED);
    expect(deriveMcpUrl(undefined)).toBe('http://localhost:8080/mcp');
    expect(deriveMcpUrl('')).toBe('http://localhost:8080/mcp');
  });
});
