// spec-304 t-58 (issue-24 #1): the app-global mount point for the desktop MCP
// status derivation. Renders nothing — it exists so the probe → derive → push
// (useDesktopMcpStatus) runs on EVERY route, keeping the native nav-bar pill
// populated regardless of which page is open (the page-scoped DesktopMcpSection
// only ran it on Settings → Integrations). Mounted once near the router root
// (App.tsx PostLoginRouter).
//
// Gated on isDesktopShell() BEFORE any hook runs: in a plain browser (the 99%
// case, and every web test) this returns null without subscribing to the
// user-change SSE stream or touching auth context — the desktop status machinery
// has no reason to run there. isDesktopShell() is stable for the app's lifetime
// (the bridge is present or it isn't), so the conditional mount is hook-safe.

import { isDesktopShell } from '../desktop/bridge';
import { useDesktopMcpStatus } from '../hooks/useDesktopMcpStatus';

export function DesktopMcpStatusSync() {
  if (!isDesktopShell()) return null;
  return <DesktopMcpStatusActive />;
}

function DesktopMcpStatusActive() {
  // The hook probes, derives, and pushes the indicator to the native pill; we
  // only need it mounted, not its return value.
  useDesktopMcpStatus();
  return null;
}
