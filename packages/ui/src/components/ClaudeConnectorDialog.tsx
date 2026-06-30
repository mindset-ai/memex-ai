// spec-304 t-56 (dec-23 → ac-55): the Claude Desktop "Install for my org"
// connector-instructions dialog. Open core.
//
// dec-23 dropped the npx mcp-remote Claude Desktop path (it re-introduced the
// Node dependency the spec set out to remove, and broke on Windows — issue-22).
// Claude Desktop's Node-free remote-MCP route is an account-level Custom
// Connector added in Claude's own Connectors UI (OAuth 2.1 + PKCE + DCR, which
// the Memex server already implements). The app CANNOT write a connector — it is
// account-level and, on Team/Enterprise, only an Owner can add it — so this is
// GUIDANCE, not an in-app file write.
//
// std-34 (the honest-CTA rule): the copy says plainly that the connector is set
// up INSIDE Claude, signalling the web↔MCP capability boundary rather than
// implying the app does it.
//
// Deep-link / prefill investigation (ac-55): Claude Desktop exposes no public,
// documented URL scheme to open "Add custom connector" prefilled with a URL
// (the claude:// scheme is undocumented and not contractual). So the dialog's
// primary action is the graceful fallback — copy the connector URL + open
// Claude's settings manually + follow the steps. If a documented deep link ever
// ships, the primary action becomes that link with this as the fallback.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';

interface ClaudeConnectorDialogProps {
  /** The env-derived MCP connector URL (e.g. https://memex.ai/mcp). */
  connectorUrl: string;
  onClose: () => void;
}

export function ClaudeConnectorDialog({ connectorUrl, onClose }: ClaudeConnectorDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(connectorUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be denied (permissions / insecure context); the URL is
      // still shown on screen for manual copy, so a copy failure is non-fatal.
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-labelledby="cd-connector-heading"
        className="w-[520px] max-w-[92vw] rounded-xl border border-edge bg-panel shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h2 id="cd-connector-heading" className="text-sm font-semibold text-heading">
            Connect Claude Desktop for your org
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Honest CTA (std-34): name the boundary — this is set up inside
              Claude, the app can't add the connector for you. */}
          <p className="text-sm text-muted">
            Claude Desktop connects to Memex through a{' '}
            <span className="font-medium text-primary">Custom Connector</span> you add inside
            Claude — Memex can’t add it for you. Copy the connector URL below, then follow these
            steps in Claude:
          </p>

          <div>
            <div className="mb-1 text-xs font-medium text-secondary">Connector URL</div>
            <div className="flex items-center gap-2">
              <code
                data-testid="connector-url"
                className="flex-1 truncate rounded-md bg-overlay px-3 py-2 text-xs text-primary border border-edge-subtle"
              >
                {connectorUrl}
              </code>
              <Button size="sm" onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy URL'}
              </Button>
            </div>
          </div>

          <ol className="list-decimal pl-5 space-y-1.5 text-sm text-secondary">
            <li>Open <span className="text-primary">Claude → Customize → Connectors</span>.</li>
            <li>Click the <span className="text-primary">+</span> next to Connectors.</li>
            <li>Click <span className="text-primary">Add custom connector</span>.</li>
            <li>Paste the connector URL above.</li>
            <li>Keep <span className="text-primary">Individual sign-in</span> selected (each person signs in with their own Memex login).</li>
            <li>Click <span className="text-primary">Add</span>, then sign in to Memex when prompted.</li>
            <li>Restart Claude Desktop to finish connecting.</li>
          </ol>

          {/* The admin reality on Team/Enterprise (dec-23). */}
          <p className="rounded-md bg-overlay px-3 py-2 text-xs text-muted border border-edge-subtle">
            <span className="font-medium text-secondary">Managed Claude plan?</span> Only a workspace
            Owner can add a custom connector. Once an Owner has added it, every member signs in
            individually with their own Memex login.
          </p>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-edge">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
