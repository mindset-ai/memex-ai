import { useState } from 'react';
import { MarkdownText } from '../MarkdownText';

interface StepItem {
  label: string;
  detail?: string;
  // spec-482 dec-10: an optional ATOMIC copyable for this step. When present the
  // step renders a Copy button that writes EXACTLY this value to the clipboard —
  // never the label, the detail, or another step's value. This is what lets a
  // sequenced handoff (connect command → Spec URL → paste-prompt) live in ONE card
  // with a per-step copy each, instead of one render_handoff whose single button
  // scoops up the whole block.
  copy?: string;
  copyLabel?: string;
}

interface StepsProps {
  input: {
    title?: string;
    steps: StepItem[];
  };
}

export function Steps({ input }: StepsProps) {
  // Which step's Copy button is showing its "Copied" confirmation. Only one at a
  // time — a fresh copy supersedes the previous step's confirmation.
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyStep = (i: number, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopiedIndex(i);
      setTimeout(() => setCopiedIndex((cur) => (cur === i ? null : cur)), 1500);
    });
  };

  return (
    <div className="my-3 rounded-lg border border-edge-subtle bg-overlay px-4 py-3">
      {input.title && (
        <div className="text-xs font-medium uppercase tracking-wider text-muted mb-2">
          <MarkdownText>{input.title}</MarkdownText>
        </div>
      )}
      <ol className="space-y-2">
        {input.steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex-none flex items-center justify-center w-6 h-6 rounded-full bg-accent/15 text-accent text-xs font-semibold tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="text-sm text-primary leading-snug">
                <MarkdownText>{step.label}</MarkdownText>
              </div>
              {step.detail && (
                <div className="text-xs text-muted mt-0.5">
                  <MarkdownText>{step.detail}</MarkdownText>
                </div>
              )}
              {step.copy && (
                <div
                  data-testid="step-copy"
                  className="mt-2 flex items-center gap-2 rounded-md border border-edge bg-input px-2.5 py-1.5"
                >
                  {/* The exact bytes copied — displayed verbatim, monospace, its own
                      scroll so a long command/URL never widens the card. */}
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-primary/90">
                    {step.copy}
                  </code>
                  <button
                    type="button"
                    data-testid="step-copy-button"
                    aria-label={`${step.copyLabel ?? 'Copy'}: ${step.copy}`}
                    onClick={() => copyStep(i, step.copy as string)}
                    className="flex-none rounded-sm border border-edge bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20 hover:text-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {copiedIndex === i ? 'Copied' : (step.copyLabel ?? 'Copy')}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
