// spec-304 t-55 (dec-19, dec-20, dec-22): typed wrappers over the desktop
// shell's JS↔Dart bridge. The Memex React UI is hosted inside a Flutter
// `flutter_inappwebview` that exposes `window.flutter_inappwebview.callHandler`;
// in a plain browser the bridge is undefined and every call is a guarded no-op.
//
// Intent + credential live here in React (the session can mint an mxt_ token
// with no device flow); the OS-capable actions (write ~/.claude.json, raise a
// native toast) run in Dart through these handlers.

import type { McpStatusResult } from './mcpStatus';

declare global {
  interface Window {
    flutter_inappwebview?: {
      callHandler: (handlerName: string, ...args: unknown[]) => unknown;
    };
  }
}

/** Which Claude client an install/remove targets (Dart accepts these spellings). */
export type McpTargetKey = 'claudeCode' | 'claudeDesktop';

/** The structured result every install/remove handler resolves to (never rejects). */
export interface BridgeWriteResult {
  ok: boolean;
  /** Set when the existing config is JSONC — re-issue with `force: true`. */
  needsConfirmation?: boolean;
  name?: string;
  path?: string;
  backupPath?: string;
  removed?: boolean;
  error?: string;
}

function bridge(): Window['flutter_inappwebview'] {
  return typeof window === 'undefined' ? undefined : window.flutter_inappwebview;
}

/** Whether the UI is running inside the Memex desktop shell (vs a plain browser). */
export function isDesktopShell(): boolean {
  return !!bridge();
}

/**
 * The absolute server base the desktop shell should derive the MCP URL from.
 * The webview is served from the same origin as the API + MCP, so the origin is
 * the base; Dart strips a trailing `/api` and appends `/mcp`. Returns null
 * outside a browser.
 */
export function desktopServerBase(): string | null {
  if (typeof window === 'undefined') return null;
  return window.location.origin;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const b = bridge();
  if (!b) throw new Error('Memex desktop shell is not available');
  return (await b.callHandler(name, args)) as T;
}

/** Install (or repair/reinstall) the memex MCP entry into a Claude client. */
export function installMcpBridge(opts: {
  token: string;
  target: McpTargetKey;
  serverBase?: string | null;
  force?: boolean;
}): Promise<BridgeWriteResult> {
  return call<BridgeWriteResult>('installMcp', {
    token: opts.token,
    target: opts.target,
    serverBase: opts.serverBase ?? desktopServerBase(),
    ...(opts.force ? { force: true } : {}),
  });
}

/** Remove the memex MCP entry from a Claude client (inverse of install). */
export function removeMcpBridge(opts: {
  target: McpTargetKey;
  force?: boolean;
}): Promise<BridgeWriteResult> {
  return call<BridgeWriteResult>('removeMcp', {
    target: opts.target,
    ...(opts.force ? { force: true } : {}),
  });
}

/**
 * Read-only probe of both Claude clients' local configs. Returns null outside
 * the desktop shell (a plain browser has no local Claude config to read).
 */
export async function mcpStatusBridge(
  serverBase?: string | null,
): Promise<McpStatusResult | null> {
  const b = bridge();
  if (!b) return null;
  const res = (await b.callHandler('mcpStatus', {
    serverBase: serverBase ?? desktopServerBase(),
  })) as { ok: boolean; targets: McpStatusResult };
  return res?.ok ? res.targets : null;
}

/**
 * Raise a native OS notification via the shell (dec-22). A no-op (resolves
 * false) in a plain browser. Used to announce a successful install so it
 * surfaces system-wide after the user alt-tabs to restart Claude.
 */
export async function showNotificationBridge(opts: {
  title: string;
  body?: string;
  target?: string;
}): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  const res = (await b.callHandler('showNotification', opts)) as { ok: boolean };
  return !!res?.ok;
}

/** The app-global MCP indicator state React pushes to the native pill (dec-21). */
export interface McpIndicatorPush {
  kind: 'connected' | 'ready' | 'repair' | 'install';
  label: string;
  visibility: 'transient' | 'persistent' | 'snoozable';
}

/**
 * Push the derived indicator state to the native pill (dec-21). React owns the
 * truth; Dart owns the chrome + the 5–10s on-open timing. A no-op in a plain
 * browser, and tolerant of a shell build that predates the handler.
 */
export async function setMcpStatusBridge(push: McpIndicatorPush): Promise<void> {
  const b = bridge();
  if (!b) return;
  try {
    await b.callHandler('setMcpStatus', push);
  } catch {
    // An older shell without setMcpStatus must never break the web surface.
  }
}
