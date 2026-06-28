// spec-304 t-55 (s-17 "the install flow"): the in-app MCP install orchestration,
// extracted from the React component so the whole mint→install→confirm→notify
// sequence is unit-testable with injected dependencies. The session token is
// minted in-process and handed straight to the native bridge — it is never
// shown, logged, or persisted (ac-6). Nothing partial is left behind on failure.

import type { BridgeWriteResult, McpTargetKey } from './bridge';

export interface InstallDeps {
  /** Mint a fresh mxt_ token from the logged-in session (ac-6). */
  mint: (label: string) => Promise<{ token: string }>;
  /** Write the entry via the native installMcp bridge. */
  install: (opts: {
    token: string;
    target: McpTargetKey;
    force?: boolean;
  }) => Promise<BridgeWriteResult>;
  /** Raise the native success toast prompting a Claude restart (ac-51, dec-22). */
  notify: (opts: { title: string; body: string; target?: string }) => Promise<boolean>;
  /** Ask the user to back up & overwrite a JSONC config. Returns false to cancel. */
  confirmOverwrite: (name: string, path: string) => boolean | Promise<boolean>;
}

export type InstallOutcome =
  | { ok: true; client: string; backupPath?: string }
  | { ok: false; reason: string };

/** The label every desktop-minted token carries, so they're recognisable in the token list. */
export const DESKTOP_TOKEN_LABEL = 'Memex Desktop';

/**
 * Run the full in-app install for one Claude client:
 *  1. mint a token from the live session (no terminal / device flow — ac-6),
 *  2. write it via the bridge, preserving siblings + taking a .bak (ac-4),
 *  3. if the config is JSONC, prompt and re-issue with `force` (s-17 step 5),
 *  4. on success, raise a native OS notification telling the user to restart
 *     Claude so the tools load (ac-7, ac-51).
 * Any failure returns a plain reason; nothing partial is left behind.
 */
export async function runInstall(
  target: McpTargetKey,
  clientName: string,
  deps: InstallDeps,
): Promise<InstallOutcome> {
  let token: string;
  try {
    const minted = await deps.mint(DESKTOP_TOKEN_LABEL);
    token = minted.token;
  } catch (err) {
    return { ok: false, reason: reason(err, 'Could not mint a token from your session') };
  }
  if (!token) return { ok: false, reason: 'Could not mint a token from your session' };

  let res: BridgeWriteResult;
  try {
    res = await deps.install({ token, target });
  } catch (err) {
    return { ok: false, reason: reason(err, 'Install failed') };
  }

  // JSONC branch: the bridge did NOT overwrite. Confirm, then re-issue forced.
  if (!res.ok && res.needsConfirmation) {
    const proceed = await deps.confirmOverwrite(res.name ?? clientName, res.path ?? '');
    if (!proceed) return { ok: false, reason: 'cancelled' };
    try {
      res = await deps.install({ token, target, force: true });
    } catch (err) {
      return { ok: false, reason: reason(err, 'Install failed') };
    }
  }

  if (!res.ok) {
    return { ok: false, reason: res.error ?? 'Install failed' };
  }

  // Success — announce natively so completion surfaces even after the user
  // alt-tabs to restart Claude (dec-22). The toast is best-effort; a browser
  // (or a shell that can't toast) must not fail the install.
  await deps
    .notify({
      title: 'MCP ready',
      body: `Restart ${clientName} to finish connecting Memex.`,
      target: 'mcp',
    })
    .catch(() => false);

  return { ok: true, client: clientName, backupPath: res.backupPath };
}

function reason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
