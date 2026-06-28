import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  deriveClientStatus,
  deriveIndicator,
  type ClientStatus,
  type McpTargetStatus,
} from './mcpStatus';

const AC_DERIVE = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-48';
const AC_INDICATOR =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-49';

const ACTIVE = new Set(['mxt_active1234']);

function local(over: Partial<McpTargetStatus> = {}): McpTargetStatus {
  return {
    installed: true,
    urlMatches: true,
    tokenPrefix: 'mxt_active1234',
    ...over,
  };
}

describe('spec-304 ac-48: per-client status derivation (local ⨝ active tokens ⨝ connection)', () => {
  it('absent config → Not installed / Install (never an error)', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(undefined, { activeTokenPrefixes: ACTIVE, connected: false }),
    ).toEqual({ kind: 'not_installed', label: 'Not installed', button: 'install' });
    expect(
      deriveClientStatus(local({ installed: false }), {
        activeTokenPrefixes: ACTIVE,
        connected: false,
      }).kind,
    ).toBe('not_installed');
  });

  it('installed + active token + no handshake → MCP ready / Reinstall', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local(), { activeTokenPrefixes: ACTIVE, connected: false }),
    ).toEqual({ kind: 'ready', label: 'MCP ready', button: 'reinstall' });
  });

  it('installed + active token + handshake observed → MCP connected', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local(), { activeTokenPrefixes: ACTIVE, connected: true }),
    ).toEqual({ kind: 'connected', label: 'MCP connected', button: 'reinstall' });
  });

  it('installed but token revoked / unknown → Token invalid / Repair', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local({ tokenPrefix: 'mxt_revoked999' }), {
        activeTokenPrefixes: ACTIVE,
        connected: true, // even a stale handshake must not mask a dead token
      }),
    ).toEqual({ kind: 'repair', label: 'Token invalid', button: 'repair' });
  });

  it('installed but no extractable token → Repair (cannot confirm authorization)', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local({ tokenPrefix: null }), {
        activeTokenPrefixes: ACTIVE,
        connected: false,
      }).kind,
    ).toBe('repair');
  });

  it('installed but pointing at a different server → Points elsewhere / Reinstall', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local({ urlMatches: false }), {
        activeTokenPrefixes: ACTIVE,
        connected: false,
      }),
    ).toEqual({ kind: 'reinstall', label: 'Points elsewhere', button: 'reinstall' });
  });
});

describe('spec-304 ac-49: app-global indicator — quiet, honest, MCP-led wording', () => {
  const s = (kind: ClientStatus['kind']): ClientStatus => ({
    kind,
    label: 'x',
    button: 'install',
  });

  it('every non-empty indicator label leads with "MCP"', () => {
    tagAc(AC_INDICATOR);
    for (const kinds of [
      ['connected'],
      ['ready'],
      ['repair'],
      ['reinstall'],
      ['not_installed'],
    ] as ClientStatus['kind'][][]) {
      const label = deriveIndicator(kinds.map(s)).label;
      expect(label.startsWith('MCP') || label === 'Install MCP').toBe(true);
    }
  });

  it('connected wins and is transient (auto-hides in the healthy steady state)', () => {
    tagAc(AC_INDICATOR);
    expect(deriveIndicator([s('connected'), s('not_installed')])).toEqual({
      kind: 'connected',
      label: 'MCP connected',
      visibility: 'transient',
    });
  });

  it('ready (installed, no handshake) is transient and never reads "connected"', () => {
    tagAc(AC_INDICATOR);
    const ind = deriveIndicator([s('ready'), s('not_installed')]);
    expect(ind.kind).toBe('ready');
    expect(ind.label).toBe('MCP ready');
    expect(ind.label).not.toContain('connected');
    expect(ind.visibility).toBe('transient');
  });

  it('a broken install (repair / wrong-server) is a PERSISTENT "MCP needs repair" badge', () => {
    tagAc(AC_INDICATOR);
    expect(deriveIndicator([s('repair'), s('not_installed')])).toEqual({
      kind: 'repair',
      label: 'MCP needs repair',
      visibility: 'persistent',
    });
    expect(deriveIndicator([s('reinstall')]).visibility).toBe('persistent');
  });

  it('nothing installed → quiet, snoozable "Install MCP" prompt (an opportunity, not an alarm)', () => {
    tagAc(AC_INDICATOR);
    expect(deriveIndicator([s('not_installed'), s('not_installed')])).toEqual({
      kind: 'install',
      label: 'Install MCP',
      visibility: 'snoozable',
    });
  });

  it('a connected client beside a never-installed one is not "needs repair"', () => {
    tagAc(AC_INDICATOR);
    // never-installed ≠ broken: the second client being absent must not raise an alarm.
    expect(deriveIndicator([s('connected'), s('not_installed')]).kind).toBe('connected');
  });
});
