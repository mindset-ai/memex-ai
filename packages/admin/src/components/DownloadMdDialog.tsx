import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import type { MarkdownOptions } from '../utils/specMarkdown';

interface DownloadMdDialogProps {
  onConfirm: (options: MarkdownOptions) => void;
  onClose: () => void;
}

const OPTIONS: Array<{ key: keyof MarkdownOptions; label: string; description: string }> = [
  { key: 'includeSections', label: 'Spec', description: 'The spec itself (all sections)' },
  { key: 'includeDecisions', label: 'Decisions', description: 'Open and resolved decisions with their context and resolutions' },
  { key: 'includeTasks', label: 'Tasks', description: 'Tasks with acceptance criteria, status, and blockers' },
  { key: 'includeComments', label: 'Comments', description: 'Discussion threads on sections, decisions, and tasks' },
];

export function DownloadMdDialog({ onConfirm, onClose }: DownloadMdDialogProps) {
  const [options, setOptions] = useState<MarkdownOptions>({
    includeSections: true,
    includeDecisions: false,
    includeTasks: false,
    includeComments: false,
  });

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

  const toggle = (key: keyof MarkdownOptions) =>
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[480px] rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h2 className="text-sm font-semibold text-heading">Download as Markdown</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-muted">Choose what to include in the download:</p>
          {OPTIONS.map((opt) => (
            <label
              key={opt.key}
              className="flex gap-3 items-start cursor-pointer px-3 py-2 rounded-lg hover:bg-overlay"
            >
              <input
                type="checkbox"
                checked={options[opt.key]}
                onChange={() => toggle(opt.key)}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-primary">{opt.label}</div>
                <div className="text-xs text-muted">{opt.description}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-edge">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onConfirm(options)}>
            Download
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
