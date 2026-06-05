import { Button } from '../../ui';
import { MarkdownText } from '../MarkdownText';

interface ConfirmationProps {
  toolId: string;
  input: { message: string; confirmLabel?: string; cancelLabel?: string };
  disabled: boolean;
  onRespond: (toolId: string, result: string) => void;
}

export function Confirmation({ toolId, input, disabled, onRespond }: ConfirmationProps) {
  return (
    <div className="my-2 px-3 py-3 rounded-lg border bg-overlay border-edge-subtle">
      <div className="text-sm mb-3 text-primary">
        <MarkdownText inline={false}>{input.message}</MarkdownText>
      </div>
      <div className="flex gap-2">
        <Button
          onClick={() => onRespond(toolId, 'confirmed')}
          disabled={disabled}
          variant="success"
        >
          {input.confirmLabel ?? 'Confirm'}
        </Button>
        <Button
          onClick={() => onRespond(toolId, 'cancelled')}
          disabled={disabled}
          variant="secondary"
        >
          {input.cancelLabel ?? 'Cancel'}
        </Button>
      </div>
    </div>
  );
}
