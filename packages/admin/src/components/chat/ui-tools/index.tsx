import { ActionButtons } from './ActionButtons';
import { Choices } from './Choices';
import { Confirmation } from './Confirmation';
import { Progress } from './Progress';
import { Callout } from './Callout';
import { Steps } from './Steps';

interface UiToolRendererProps {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  disabled: boolean;
  onRespond: (toolId: string, result: string) => void;
}

export function UiToolRenderer({ toolName, toolId, input, disabled, onRespond }: UiToolRendererProps) {
  switch (toolName) {
    case 'render_action_buttons':
      return (
        <ActionButtons
          toolId={toolId}
          input={input as { buttons: { label: string; action: string; variant?: 'primary' | 'secondary' | 'danger' }[] }}
          disabled={disabled}
          onRespond={onRespond}
        />
      );
    case 'render_choices':
      return (
        <Choices
          toolId={toolId}
          input={input as { question: string; options: { label: string; value: string; description?: string }[] }}
          disabled={disabled}
          onRespond={onRespond}
        />
      );
    case 'render_confirmation':
      return (
        <Confirmation
          toolId={toolId}
          input={input as { message: string; confirmLabel?: string; cancelLabel?: string }}
          disabled={disabled}
          onRespond={onRespond}
        />
      );
    case 'render_progress':
      return (
        <Progress
          input={input as { steps: { label: string; status: 'pending' | 'in_progress' | 'complete' | 'error' }[] }}
        />
      );
    case 'render_callout':
      return (
        <Callout
          input={input as { tone?: 'info' | 'success' | 'tip' | 'warning'; heading: string; body: string }}
        />
      );
    case 'render_steps':
      return (
        <Steps
          input={input as { title?: string; steps: { label: string; detail?: string }[] }}
        />
      );
    default:
      return (
        <div className="text-xs text-muted">
          Unknown UI tool: {toolName}
        </div>
      );
  }
}
