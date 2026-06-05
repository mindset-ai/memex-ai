import { Button } from '../../ui';

interface ButtonDef {
  label: string;
  action: string;
  variant?: 'primary' | 'secondary' | 'danger';
}

interface ActionButtonsProps {
  toolId: string;
  input: { buttons: ButtonDef[] };
  disabled: boolean;
  onRespond: (toolId: string, result: string) => void;
}

export function ActionButtons({ toolId, input, disabled, onRespond }: ActionButtonsProps) {
  return (
    <div className="flex flex-wrap gap-2 my-2">
      {input.buttons.map((btn) => (
        <Button
          key={btn.action}
          onClick={() => onRespond(toolId, btn.action)}
          disabled={disabled}
          variant={btn.variant ?? 'secondary'}
        >
          {btn.label}
        </Button>
      ))}
    </div>
  );
}
