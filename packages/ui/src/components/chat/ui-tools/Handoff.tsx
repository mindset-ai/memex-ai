// spec-389 t-4 (dec-3): the shared HANDOFF block. When an in-app agent is asked
// to do something outside its own function, it does NOT reach for a tool it
// shouldn't have — it refuses and hands the user a ready-to-paste prompt for the
// agent that DOES own the work (the canonical map lives in the agents' guidance
// prose, @memex/shared/scaffold-data.ts). This renders that honest handoff: a
// short reason + the target + the copyable prompt. Display-only — no response.

import { useState } from 'react';

interface HandoffProps {
  input: {
    target: string;
    prompt: string;
    reason?: string;
  };
}

export function Handoff({ input }: HandoffProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(input.prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <figure
      data-testid="agent-handoff"
      className="my-3 overflow-hidden rounded-lg border border-edge bg-muted/20"
    >
      <figcaption className="flex items-center justify-between gap-2 border-b border-edge px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Hand off to {input.target}
        </span>
        <button
          type="button"
          data-testid="handoff-copy"
          onClick={copy}
          className="flex-none text-[11px] font-medium text-accent transition-colors hover:text-primary"
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
      </figcaption>
      {input.reason ? (
        <p className="px-3 pt-2.5 text-xs leading-relaxed text-secondary">
          {input.reason}
        </p>
      ) : null}
      {/* The ready-to-paste prompt, verbatim (monospace, not markdown-parsed). */}
      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-primary/90">
        {input.prompt}
      </pre>
    </figure>
  );
}
