// spec-201: shared copy-to-clipboard code primitives, extracted from
// CliInstallSection (spec-141) so the new GenesisPromptSection reuses them
// rather than duplicating. Pure presentation, open core.

import { useState } from 'react';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="absolute top-2 right-2 px-2 py-1 text-xs font-medium rounded transition-colors bg-btn-secondary hover:bg-btn-secondary-hover text-secondary"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative group">
      <CopyButton text={code} />
      <pre className="border rounded-lg p-4 overflow-x-auto text-sm leading-relaxed bg-surface border-edge">
        <code className="text-primary">{code}</code>
      </pre>
    </div>
  );
}

export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded text-xs text-primary bg-input">{children}</code>
  );
}
