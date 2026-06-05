interface Step {
  label: string;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
}

interface ProgressProps {
  input: { steps: Step[] };
}

const statusIcons: Record<string, string> = {
  pending:     'text-muted',
  in_progress: 'text-status-info-text animate-pulse',
  complete:    'text-status-success-text',
  error:       'text-status-danger-text',
};

const statusSymbols: Record<string, string> = {
  pending: '\u25CB',
  in_progress: '\u25CF',
  complete: '\u2713',
  error: '\u2717',
};

export function Progress({ input }: ProgressProps) {
  return (
    <div className="my-2 px-3 py-2 rounded-lg border bg-overlay border-edge-subtle">
      <div className="space-y-1.5">
        {input.steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={`text-sm font-mono ${statusIcons[step.status]}`}>
              {statusSymbols[step.status]}
            </span>
            <span
              className={`text-sm ${
                step.status === 'complete'
                  ? 'text-muted'
                  : step.status === 'error'
                  ? 'text-status-danger-text'
                  : 'text-primary'
              }`}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
