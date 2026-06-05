import { MarkdownText } from '../MarkdownText';

interface StepItem {
  label: string;
  detail?: string;
}

interface StepsProps {
  input: {
    title?: string;
    steps: StepItem[];
  };
}

export function Steps({ input }: StepsProps) {
  return (
    <div className="my-3 rounded-lg border border-edge-subtle bg-overlay/60 px-4 py-3">
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
            <div className="min-w-0 pt-0.5">
              <div className="text-sm text-primary leading-snug">
                <MarkdownText>{step.label}</MarkdownText>
              </div>
              {step.detail && (
                <div className="text-xs text-muted mt-0.5">
                  <MarkdownText>{step.detail}</MarkdownText>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
