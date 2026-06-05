import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import { INIT_PROMPT_MODES, type InitPromptMode } from '../utils/specInitPrompt';

interface InitPromptDialogProps {
  defaultMode?: InitPromptMode;
  onCopy: (mode: InitPromptMode) => Promise<void> | void;
  onClose: () => void;
}

const MODE_ORDER: InitPromptMode[] = ['evolve', 'plan', 'execute', 'decisions', 'comments', 'freeform'];

export function InitPromptDialog({ defaultMode = 'evolve', onCopy, onClose }: InitPromptDialogProps) {
  const [mode, setMode] = useState<InitPromptMode>(defaultMode);
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
    await onCopy(mode);
    setCopied(true);
    setTimeout(() => onClose(), 900);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[480px] rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h2 className="text-sm font-semibold text-heading">Spec Coding Agent</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-2">
          <p className="text-sm text-muted">
            Pick what you want the coding agent to start on. The prompt is copied to your clipboard — paste it into a fresh coding session.
          </p>
          <div className="space-y-1 pt-1">
            {MODE_ORDER.map((m) => {
              const def = INIT_PROMPT_MODES[m];
              const selected = mode === m;
              return (
                <label
                  key={m}
                  className={`flex gap-3 items-start cursor-pointer px-3 py-2 rounded-lg border transition-colors ${
                    selected ? 'border-accent bg-overlay' : 'border-transparent hover:bg-overlay'
                  }`}
                >
                  <input
                    type="radio"
                    name="init-prompt-mode"
                    checked={selected}
                    onChange={() => setMode(m)}
                    className="mt-1"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-primary">{def.label}</div>
                    <div className="text-xs text-muted">{def.description}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-edge">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy prompt'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
