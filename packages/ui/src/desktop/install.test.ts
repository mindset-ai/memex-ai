import { describe, it, expect, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { runInstall, DESKTOP_TOKEN_LABEL, type InstallDeps } from './install';

const AC_INSTALL = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-4';
const AC_SESSION = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-6';
const AC_RESTART = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-7';
const AC_NOTIFY = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-51';
const AC_UMBRELLA =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-45';
// dec-25 → t-70: on install failure, runInstall raises a native FAILURE
// notification (mirroring the success toast) and classifies the failure mode
// (mint vs config-write vs unknown) so the surface can explain it.
const AC_FAIL_NOTIFY =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-69';

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    mint: vi.fn(async () => ({ token: 'mxt_secret_never_shown_123' })),
    install: vi.fn(async () => ({ ok: true, name: 'Claude Code', path: '/p', backupPath: '/p.bak' })),
    notify: vi.fn(async () => true),
    confirmOverwrite: vi.fn(() => true),
    ...over,
  };
}

describe('spec-304 ac-6: token comes from the live session, no terminal/device flow', () => {
  it('mints a labelled token and hands it straight to the bridge — never returns it', async () => {
    tagAc(AC_SESSION);
    tagAc(AC_UMBRELLA);
    const d = deps();
    const out = await runInstall('claudeCode', 'Claude Code', d);

    expect(out).toEqual({ ok: true, client: 'Claude Code', backupPath: '/p.bak' });
    expect(d.mint).toHaveBeenCalledWith(DESKTOP_TOKEN_LABEL);
    // The token flowed mint → install and nowhere else; the outcome carries no secret.
    expect(d.install).toHaveBeenCalledWith({
      token: 'mxt_secret_never_shown_123',
      target: 'claudeCode',
    });
    expect(JSON.stringify(out)).not.toContain('mxt_secret');
  });
});

describe('spec-304 ac-4: install writes via the bridge (no-clobber + .bak surfaced)', () => {
  it('returns the client + backup path on a clean write', async () => {
    tagAc(AC_INSTALL);
    const out = await runInstall('claudeDesktop', 'Claude Desktop', deps());
    expect(out).toEqual({ ok: true, client: 'Claude Desktop', backupPath: '/p.bak' });
  });

  it('JSONC config: prompts, then re-issues with force after confirmation', async () => {
    tagAc(AC_INSTALL);
    const install = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsConfirmation: true, name: 'Claude Code', path: '/c' })
      .mockResolvedValueOnce({ ok: true, name: 'Claude Code', path: '/c', backupPath: '/c.bak' });
    const confirmOverwrite = vi.fn(() => true);
    const d = deps({ install, confirmOverwrite });

    const out = await runInstall('claudeCode', 'Claude Code', d);

    expect(confirmOverwrite).toHaveBeenCalledWith('Claude Code', '/c');
    expect(install).toHaveBeenNthCalledWith(2, {
      token: 'mxt_secret_never_shown_123',
      target: 'claudeCode',
      force: true,
    });
    expect(out.ok).toBe(true);
  });

  it('JSONC config: cancelling the prompt leaves nothing installed', async () => {
    tagAc(AC_INSTALL);
    const install = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsConfirmation: true, name: 'Claude Code', path: '/c' });
    const d = deps({ install, confirmOverwrite: vi.fn(() => false) });

    const out = await runInstall('claudeCode', 'Claude Code', d);

    expect(out).toEqual({ ok: false, reason: 'cancelled', failure: 'cancelled' });
    expect(install).toHaveBeenCalledTimes(1); // never forced
  });

  it('a bridge failure returns a plain reason and raises the FAILURE toast — never the success one (dec-25)', async () => {
    tagAc(AC_INSTALL);
    const notify = vi.fn(async () => true);
    const d = deps({
      install: vi.fn(async () => ({ ok: false, error: 'disk full' })),
      notify,
    });
    const out = await runInstall('claudeCode', 'Claude Code', d);
    expect(out).toEqual({ ok: false, reason: 'disk full', failure: 'config-write', error: 'disk full' });
    // dec-25: a failure now notifies — but with the FAILURE shape, never the
    // "MCP ready / Restart" success toast.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].title).not.toMatch(/ready/i);
    expect(notify.mock.calls[0][0].body).not.toMatch(/Restart/i);
  });

  it('a mint failure aborts before touching the bridge', async () => {
    tagAc(AC_SESSION);
    const install = vi.fn();
    const d = deps({ mint: vi.fn(async () => { throw new Error('session expired'); }), install });
    const out = await runInstall('claudeCode', 'Claude Code', d);
    expect(out).toEqual({ ok: false, reason: 'session expired', failure: 'mint', error: 'session expired' });
    expect(install).not.toHaveBeenCalled();
  });
});

describe('spec-304 ac-7 / ac-51: success announces a native restart prompt', () => {
  it('raises a native notification telling the user to restart that client', async () => {
    tagAc(AC_RESTART);
    tagAc(AC_NOTIFY);
    const notify = vi.fn(async () => true);
    await runInstall('claudeDesktop', 'Claude Desktop', deps({ notify }));
    expect(notify).toHaveBeenCalledTimes(1);
    const arg = notify.mock.calls[0][0];
    expect(arg.title).toMatch(/MCP/);
    expect(arg.body).toMatch(/Restart Claude Desktop/);
  });

  it('a toast failure does not fail the install (best-effort)', async () => {
    tagAc(AC_NOTIFY);
    const out = await runInstall('claudeCode', 'Claude Code', deps({
      notify: vi.fn(async () => { throw new Error('no notification permission'); }),
    }));
    expect(out.ok).toBe(true);
  });
});

describe('spec-304 ac-69 (dec-25): install failure raises a native failure notification + classifies the mode', () => {
  it('a MINT failure → failure:"mint", carries the underlying error, and notifies with a failure-shaped payload', async () => {
    tagAc(AC_FAIL_NOTIFY);
    const notify = vi.fn(async () => true);
    const out = await runInstall('claudeCode', 'Claude Code', deps({
      mint: vi.fn(async () => { throw new Error('session expired'); }),
      notify,
    }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.failure).toBe('mint');
    expect(out.error).toBe('session expired');
    // Native failure notification mirrors the success toast (target 'mcp').
    expect(notify).toHaveBeenCalledTimes(1);
    const arg = notify.mock.calls[0][0];
    expect(arg.title).toMatch(/MCP/);
    expect(arg.title.toLowerCase()).toMatch(/fail|could ?n.t|error/);
    expect(arg.target).toBe('mcp');
    // The secret session token must NEVER appear in the failure notification.
    expect(JSON.stringify(arg)).not.toContain('mxt_');
  });

  it('a CONFIG-WRITE failure (bridge returns ok:false) → failure:"config-write", carries path + error, and notifies', async () => {
    tagAc(AC_FAIL_NOTIFY);
    const notify = vi.fn(async () => true);
    const out = await runInstall('claudeCode', 'Claude Code', deps({
      install: vi.fn(async () => ({ ok: false, error: 'disk full', path: '/home/u/.claude.json' })),
      notify,
    }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.failure).toBe('config-write');
    expect(out.error).toBe('disk full');
    expect(out.configPath).toBe('/home/u/.claude.json');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].target).toBe('mcp');
  });

  it('a CONFIG-WRITE failure that THROWS → failure:"config-write" and still notifies', async () => {
    tagAc(AC_FAIL_NOTIFY);
    const notify = vi.fn(async () => true);
    const out = await runInstall('claudeCode', 'Claude Code', deps({
      install: vi.fn(async () => { throw new Error('EACCES'); }),
      notify,
    }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.failure).toBe('config-write');
    expect(out.error).toBe('EACCES');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('the native failure notification is best-effort — a notify throw never fails the flow', async () => {
    tagAc(AC_FAIL_NOTIFY);
    const out = await runInstall('claudeCode', 'Claude Code', deps({
      install: vi.fn(async () => ({ ok: false, error: 'disk full' })),
      notify: vi.fn(async () => { throw new Error('no notification permission'); }),
    }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.failure).toBe('config-write');
  });

  it('an UNKNOWN failure (mint returns a falsy token, no throw) → failure:"unknown" and still notifies', async () => {
    tagAc(AC_FAIL_NOTIFY);
    const notify = vi.fn(async () => true);
    const install = vi.fn();
    const out = await runInstall('claudeCode', 'Claude Code', deps({
      mint: vi.fn(async () => ({ token: '' })),
      install,
      notify,
    }));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    // The defensive falsy-token-without-throw branch classifies as 'unknown'…
    expect(out.failure).toBe('unknown');
    // …never touches the bridge (no token to write)…
    expect(install).not.toHaveBeenCalled();
    // …and still raises the best-effort native failure notification (ac-69).
    expect(notify).toHaveBeenCalledTimes(1);
    const arg = notify.mock.calls[0][0];
    expect(arg.title).toMatch(/MCP/);
    expect(arg.target).toBe('mcp');
  });

  it('a CANCELLED JSONC overwrite is NOT a failure — no notification', async () => {
    tagAc(AC_FAIL_NOTIFY);
    const notify = vi.fn(async () => true);
    const install = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsConfirmation: true, name: 'Claude Code', path: '/c' });
    const out = await runInstall('claudeCode', 'Claude Code', deps({
      install,
      confirmOverwrite: vi.fn(() => false),
      notify,
    }));
    expect(out).toEqual({ ok: false, reason: 'cancelled', failure: 'cancelled' });
    expect(notify).not.toHaveBeenCalled();
  });
});
