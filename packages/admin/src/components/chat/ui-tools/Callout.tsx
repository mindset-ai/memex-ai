import { MarkdownText } from '../MarkdownText';

type Tone = 'info' | 'success' | 'tip' | 'warning';

interface CalloutProps {
  input: {
    tone?: Tone;
    heading: string;
    body: string;
  };
}

// Status `*-bg` tokens in this app have baked-in opacity, so Tailwind's `/alpha`
// modifier does NOT work on them. Info and tip use the accent colour (which IS
// alpha-capable) with an explicit /10 tint; success and warning use the status
// tokens at full strength — the tokens are already designed to be a subtle
// tint in both light and dark themes.
const toneStyles: Record<
  Tone,
  { border: string; bg: string; icon: string; iconColor: string }
> = {
  info: {
    border: 'border-accent/30',
    bg: 'bg-accent/10',
    iconColor: 'text-accent',
    icon: 'M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z',
  },
  tip: {
    border: 'border-accent/30',
    bg: 'bg-accent/10',
    iconColor: 'text-accent',
    icon: 'M12 3a6 6 0 016 6c0 2.5-1.5 4.5-3 5.5V17a1 1 0 01-1 1h-4a1 1 0 01-1-1v-2.5C7.5 13.5 6 11.5 6 9a6 6 0 016-6zM10 21h4',
  },
  success: {
    border: 'border-status-success-border/50',
    bg: 'bg-status-success-bg',
    iconColor: 'text-status-success-text',
    icon: 'M5 13l4 4L19 7',
  },
  warning: {
    border: 'border-status-danger-border/50',
    bg: 'bg-status-danger-bg',
    iconColor: 'text-status-danger-text',
    icon: 'M12 9v3m0 3h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
  },
};

export function Callout({ input }: CalloutProps) {
  const tone = input.tone ?? 'info';
  const style = toneStyles[tone];

  return (
    <div
      className={`my-3 flex gap-3 rounded-lg border ${style.border} ${style.bg} px-4 py-3`}
      role="note"
    >
      <svg
        className={`flex-none w-5 h-5 mt-0.5 ${style.iconColor}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={style.icon} />
      </svg>
      <div className="min-w-0">
        <div className={`text-sm font-semibold mb-1 ${style.iconColor}`}>
          <MarkdownText>{input.heading}</MarkdownText>
        </div>
        <div className="text-sm text-primary/90">
          <MarkdownText inline={false}>{input.body}</MarkdownText>
        </div>
      </div>
    </div>
  );
}
