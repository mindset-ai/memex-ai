import { useState } from 'react';
import { MarkdownText } from '../MarkdownText';

interface Option {
  label: string;
  value: string;
  description?: string;
}

interface ChoicesProps {
  toolId: string;
  input: { question: string; options: Option[] };
  disabled: boolean;
  onRespond: (toolId: string, result: string) => void;
}

export function Choices({ toolId, input, disabled, onRespond }: ChoicesProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const handleClick = (value: string) => {
    setSelected(value);
    onRespond(toolId, value);
  };

  return (
    <div className="my-2 space-y-2">
      <div className="text-sm text-primary">
        <MarkdownText>{input.question}</MarkdownText>
      </div>
      <div className="space-y-1.5">
        {input.options.map((opt) => {
          const isSelected = selected === opt.value;
          const isDisabled = disabled || (selected !== null && !isSelected);

          return (
            <button
              key={opt.value}
              onClick={() => handleClick(opt.value)}
              disabled={isDisabled}
              className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                isSelected
                  ? 'border-accent bg-accent/10 opacity-100'
                  : isDisabled
                    ? 'opacity-30 cursor-not-allowed bg-overlay border-edge-subtle'
                    : 'bg-overlay border-edge-subtle hover:border-edge-strong hover:bg-card-hover'
              }`}
            >
              <div className="text-sm text-primary">
                <MarkdownText>{opt.label}</MarkdownText>
              </div>
              {opt.description && (
                <div className="text-xs text-muted mt-0.5">
                  <MarkdownText>{opt.description}</MarkdownText>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
