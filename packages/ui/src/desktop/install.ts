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
  /**
   * Raise a native OS notification (ac-51, dec-22): the success toast prompting
   * a Claude restart, AND — since dec-25 — the install-FAILURE toast so a failed
   * action surfaces system-wide even if the webview isn't focused (ac-69).
   */
  notify: (opts: { title: string; body: string; target?: string }) => Promise<boolean>;
  /** Ask the user to back up & overwrite a JSONC config. Returns false to cancel. */
  confirmOverwrite: (name: string, path: string) => boolean | Promise<boolean>;
}

/**
 * Why an in-app install failed (dec-25). The Integrations surface maps each to a
 * plain-language cause (ac-68); `cancelled` is the user backing out of a JSONC
 * overwrite — benign, not surfaced as an error.
 *  - `mint`         — could not mint a session token (auth/session problem).
 *  - `config-write` — minted fine, but writing the client's config failed.
 *  - `unknown`      — a token came back falsy with no thrown error (defensive).
 */
export type InstallFailureKind = 'mint' | 'config-write' | 'unknown' | 'cancelled';

export type InstallOutcome =
  | { ok: true; client: string; backupPath?: string }
  | {
      ok: false;
      reason: string;
      /** Which stage failed — drives the plain-language cause in the UI (ac-68). */
      failure: InstallFailureKind;
      /** The client's target config path, when the bridge surfaced one (ac-68). */
      configPath?: string;
      /** The underlying error text, for the copyable diagnostic (ac-68). */
      error?: string;
    };

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
    return fail(deps, clientName, {
      failure: 'mint',
      reason: reason(err, 'Could not mint a token from your session'),
      error: errText(err),
    });
  }
  if (!token) {
    return fail(deps, clientName, {
      failure: 'unknown',
      reason: 'Could not mint a token from your session',
    });
  }

  let res: BridgeWriteResult;
  try {
    res = await deps.install({ token, target });
  } catch (err) {
    return fail(deps, clientName, {
      failure: 'config-write',
      reason: reason(err, 'Install failed'),
      error: errText(err),
    });
  }

  // JSONC branch: the bridge did NOT overwrite. Confirm, then re-issue forced.
  if (!res.ok && res.needsConfirmation) {
    const proceed = await deps.confirmOverwrite(res.name ?? clientName, res.path ?? '');
    // Cancelling is the user backing out — a benign non-failure, not surfaced
    // as an error and never notified.
    if (!proceed) return { ok: false, reason: 'cancelled', failure: 'cancelled' };
    try {
      res = await deps.install({ token, target, force: true });
    } catch (err) {
      return fail(deps, clientName, {
        failure: 'config-write',
        reason: reason(err, 'Install failed'),
        error: errText(err),
        configPath: res.path,
      });
    }
  }

  if (!res.ok) {
    return fail(deps, clientName, {
      failure: 'config-write',
      reason: res.error ?? 'Install failed',
      error: res.error,
      configPath: res.path,
    });
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

/**
 * Finalise a failed install (dec-25, ac-69): raise a native FAILURE notification
 * mirroring the success toast — so a failure surfaces system-wide even when the
 * webview isn't focused — then return the structured failure outcome the
 * Integrations surface maps to a plain-language cause (ac-68). The notification
 * is best-effort (never throws, never fails the flow), exactly like the success
 * toast. The body NEVER includes the secret session token — only the client
 * name and a short, non-secret cause.
 */
async function fail(
  deps: InstallDeps,
  clientName: string,
  detail: { failure: InstallFailureKind; reason: string; error?: string; configPath?: string },
): Promise<InstallOutcome> {
  await deps
    .notify({
      title: 'MCP install failed',
      body: `Couldn't connect Memex to ${clientName}. Open Memex to retry.`,
      target: 'mcp',
    })
    .catch(() => false);
  // Scrub any echoed session token from EVERY field of the failure outcome —
  // this is the single chokepoint through which all failures flow, so redacting
  // here guarantees no `mxt_…` reaches the surface, diagnostic, or clipboard,
  // whether the text came from a thrown error or the bridge's structured result.
  return {
    ok: false,
    reason: redactToken(detail.reason),
    failure: detail.failure,
    ...(detail.configPath ? { configPath: redactToken(detail.configPath) } : {}),
    ...(detail.error ? { error: redactToken(detail.error) } : {}),
  };
}

function reason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The underlying error text for the copyable diagnostic — never a secret. */
function errText(err: unknown): string | undefined {
  return err instanceof Error && err.message ? err.message : undefined;
}

/**
 * SECURITY (dec-25, defensive): scrub any `mxt_…` session-token substring from a
 * string before it can reach the failure outcome — and from there the copyable
 * diagnostic, the Integrations error surface, or the native notification.
 * `runInstall` never puts the token into the outcome itself, but `error` and
 * `configPath` are verbatim pass-throughs of the Dart bridge's `res.error` /
 * thrown message; a future bridge regression that echoes the minted token back
 * in its own error string must not be able to leak it through the React layer.
 */
function redactToken(text: string): string {
  // Match the `mxt_` prefix plus the whole token-like run that follows
  // (word chars cover the real base62 token and any underscore-bearing variant),
  // and replace with a marker that itself contains no `mxt_` substring.
  return text.replace(/mxt_\w+/g, '[redacted-token]');
}
