// spec-360: the scaffold assistant's verbatim-quote block. The assistant uses
// `render_scaffold_quote` instead of inline "…" + monospace runs when it quotes
// the exact prompting an agent receives — so a quote reads as a distinct, lifted
// artifact (a `<pre>`-style block) rather than blending into the agent's prose.
// Display-only: no user response. The optional `source` captions WHERE the quote
// attaches (e.g. "build phase guidance", "verify gate rubric").
//
// `copyable` adds a copy button — used when the block is a prompt meant to be
// COPIED and pasted elsewhere (e.g. a prompt to hand to the Standards agent or
// the New Spec flow, which the scaffold assistant can't run itself).

import { useState } from 'react';

interface ScaffoldQuoteProps {
  input: {
    text: string;
    source?: string;
    copyable?: boolean;
  };
}

export function ScaffoldQuote({ input }: ScaffoldQuoteProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(input.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <figure className="my-3 overflow-hidden rounded-lg border border-edge bg-muted/20">
      {input.source || input.copyable ? (
        <figcaption className="flex items-center justify-between gap-2 border-b border-edge px-3 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
            {input.source}
          </span>
          {input.copyable ? (
            <button
              type="button"
              data-testid="scaffold-quote-copy"
              onClick={copy}
              className="flex-none text-[11px] font-medium text-accent transition-colors hover:text-primary"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </figcaption>
      ) : null}
      {/* Verbatim — rendered as plain monospace text (not markdown-parsed) so the
          exact scaffold prose, including backticks and punctuation, shows as-is. */}
      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-primary/90">
        {input.text}
      </pre>
    </figure>
  );
}
