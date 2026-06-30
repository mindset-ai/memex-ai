import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  deriveClientStatus,
  deriveConnectorStatus,
  deriveIndicator,
  type ActiveToken,
  type ClientStatus,
  type McpTargetStatus,
} from './mcpStatus';

const AC_DERIVE = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-48';
const AC_INDICATOR =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-49';
// issue-23 → t-57: "connected" must be PER-TOKEN (lastUsedAt), not the
// user-scoped journey milestone.
const AC_PER_TOKEN =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-52';
// t-56 → dec-23: Claude Desktop connector status derives from the mcp.connected
// signal, independent of local config.
const AC_CONNECTOR =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-56';
// issue-31 → t-65: "MCP Ready" must STAY like the Install prompt (snoozable),
// not auto-hide like Connected (transient).
const AC_READY_STAYS =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-62';

// An active token whose matching local entry HAS handshaked (lastUsedAt set).
const CONNECTED_TOKEN: ActiveToken = {
  prefix: 'mxt_active1234',
  lastUsedAt: '2026-06-28T10:00:00.000Z',
};
// An active token freshly minted — authorized but never used against /mcp yet.
const FRESH_TOKEN: ActiveToken = { prefix: 'mxt_active1234', lastUsedAt: null };

function local(over: Partial<McpTargetStatus> = {}): McpTargetStatus {
  return {
    installed: true,
    urlMatches: true,
    tokenPrefix: 'mxt_active1234',
    ...over,
  };
}

describe('spec-304 ac-48: per-client status derivation (local ⨝ active tokens ⨝ handshake)', () => {
  it('absent config → Not installed / Install (never an error)', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(undefined, { activeTokens: [CONNECTED_TOKEN] }),
    ).toEqual({ kind: 'not_installed', label: 'Not installed', button: 'install' });
    expect(
      deriveClientStatus(local({ installed: false }), {
        activeTokens: [CONNECTED_TOKEN],
      }).kind,
    ).toBe('not_installed');
  });

  it('installed + active token + no handshake → MCP ready / Reinstall', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local(), { activeTokens: [FRESH_TOKEN] }),
    ).toEqual({ kind: 'ready', label: 'MCP ready', button: 'reinstall' });
  });

  it('installed + active token + handshake observed → MCP connected', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local(), { activeTokens: [CONNECTED_TOKEN] }),
    ).toEqual({ kind: 'connected', label: 'MCP connected', button: 'reinstall' });
  });

  it('installed but token revoked / unknown → Token invalid / Repair', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local({ tokenPrefix: 'mxt_revoked999' }), {
        // even a used token elsewhere must not mask THIS entry's dead token
        activeTokens: [CONNECTED_TOKEN],
      }),
    ).toEqual({ kind: 'repair', label: 'Token invalid', button: 'repair' });
  });

  it('installed but no extractable token → Repair (cannot confirm authorization)', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local({ tokenPrefix: null }), {
        activeTokens: [CONNECTED_TOKEN],
      }).kind,
    ).toBe('repair');
  });

  it('installed but pointing at a different server → Points elsewhere / Reinstall', () => {
    tagAc(AC_DERIVE);
    expect(
      deriveClientStatus(local({ urlMatches: false }), {
        activeTokens: [CONNECTED_TOKEN],
      }),
    ).toEqual({ kind: 'reinstall', label: 'Points elsewhere', button: 'reinstall' });
  });
});

describe('spec-304 ac-52 (issue-23): "connected" is PER-TOKEN, never the user-scoped milestone', () => {
  it('a freshly-installed token (lastUsedAt null) reads "MCP ready" — NOT connected — even when the user has connected elsewhere', () => {
    tagAc(AC_PER_TOKEN);
    // The bug: a prior MCP connection set the user-scoped mcp.connected milestone
    // true, so the just-reinstalled client falsely showed "MCP connected" before
    // its OWN token handshaked. The fix joins on the token's lastUsedAt: a fresh
    // mint is null until THAT token hits /mcp.
    const status = deriveClientStatus(local(), { activeTokens: [FRESH_TOKEN] });
    expect(status.kind).toBe('ready');
    expect(status.label).toBe('MCP ready');
    expect(status.label).not.toContain('connected');
  });

  it('the SAME token flips to "MCP connected" only once its lastUsedAt is non-null', () => {
    tagAc(AC_PER_TOKEN);
    expect(deriveClientStatus(local(), { activeTokens: [FRESH_TOKEN] }).kind).toBe(
      'ready',
    );
    expect(
      deriveClientStatus(local(), { activeTokens: [CONNECTED_TOKEN] }).kind,
    ).toBe('connected');
  });

  it('a handshake on a DIFFERENT token does not mark this install connected', () => {
    tagAc(AC_PER_TOKEN);
    // This install's entry carries mxt_active1234 (fresh); another active token
    // has been used. The other token must not paint this entry "connected".
    const otherUsed: ActiveToken = {
      prefix: 'mxt_other99999',
      lastUsedAt: '2026-06-28T09:00:00.000Z',
    };
    const status = deriveClientStatus(local(), {
      activeTokens: [FRESH_TOKEN, otherUsed],
    });
    expect(status.kind).toBe('ready');
  });
});

describe('spec-304 ac-56 (dec-24): Claude Desktop connector never asserts "connected"', () => {
  it('is a neutral, signal-free setup state — there is no per-connector signal to prove a connection', () => {
    tagAc(AC_CONNECTOR);
    // deriveConnectorStatus takes NO connection input — it cannot, and must not,
    // claim "connected" off the user-scoped (monotonic, un-attributable) signal.
    expect(deriveConnectorStatus()).toEqual({
      kind: 'not_installed',
      label: 'Set up in Claude',
      button: 'connector',
    });
  });

  it('the connector label never reads "connected"', () => {
    tagAc(AC_CONNECTOR);
    expect(deriveConnectorStatus().label.toLowerCase()).not.toContain('connect');
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

  it('ready (installed, no handshake) stays (snoozable) and never reads "connected"', () => {
    tagAc(AC_INDICATOR);
    const ind = deriveIndicator([s('ready'), s('not_installed')]);
    expect(ind.kind).toBe('ready');
    expect(ind.label).toBe('MCP ready');
    expect(ind.label).not.toContain('connected');
    // Ready stays up like Install, not auto-hidden like Connected (issue-31).
    expect(ind.visibility).toBe('snoozable');
  });

  it('ready STAYS visible like the Install prompt — snoozable, not transient (ac-62)', () => {
    tagAc(AC_READY_STAYS);
    // Ready = installed + authorized, no handshake yet: an actionable "go make
    // Claude connect" state, not the quiet healthy steady state. It must stay
    // up (dismissible) like Install, not auto-hide like Connected (issue-31).
    const ready = deriveIndicator([s('ready'), s('not_installed')]);
    expect(ready.kind).toBe('ready');
    expect(ready.visibility).toBe('snoozable');
    // It now matches the Install prompt's staying behaviour…
    expect(deriveIndicator([s('not_installed')]).visibility).toBe('snoozable');
    // …while Connected stays transient (quiet when genuinely healthy).
    expect(deriveIndicator([s('connected')]).visibility).toBe('transient');
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
