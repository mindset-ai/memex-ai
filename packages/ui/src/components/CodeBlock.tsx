// spec-201: shared copy-to-clipboard code primitives, extracted from
// CliInstallSection (spec-141) so the new GenesisPromptSection reuses them
// rather than duplicating. Pure presentation, open core.

import { useState } from 'react';

// `onCopy` (optional) fires after a successful copy — used by the onboarding journey
// steps to record a home_canvas.cta_clicked intent signal (spec-324). Default no-op,
// so every other CodeBlock usage (Settings install, Genesis prompt, …) is unaffected.
export function CopyButton({ text, onCopy }: { text: string; onCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          onCopy?.();
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="absolute top-2 right-2 px-2 py-1 text-xs font-medium rounded-sm transition-colors bg-btn-secondary hover:bg-btn-secondary-hover text-secondary"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export function CodeBlock({ code, onCopy }: { code: string; onCopy?: () => void }) {
  return (
    <div className="relative group">
      <CopyButton text={code} onCopy={onCopy} />
      {/* pr-20 reserves a gutter for the absolutely-positioned Copy button so wrapped prompt
          text (pre-wrap inside the onboarding scope) never flows underneath it — the button
          (~46px "Copy" / ~62px "Copied!" at right-2) clears with room to spare (spec-372). */}
      <pre className="border rounded-lg p-4 pr-20 overflow-x-auto text-sm leading-relaxed bg-surface border-edge">
        <code className="text-primary">{code}</code>
      </pre>
    </div>
  );
}

export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded-sm text-xs text-primary bg-input">{children}</code>
  );
}
