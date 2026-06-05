import { statusClasses } from '../../utils/statusStyles';

interface BadgeProps {
  /** Domain status string (draft, active, blocked, etc.) */
  status: string;
  /** Display label. Defaults to status string with underscores replaced. */
  label?: string;
  className?: string;
}

// spec-178 (ac-3/ac-12): the DEMO badge needs a treatment that reads as "this is a
// guided demo", visually distinct from the lifecycle status palette. `statusClasses`
// maps any unknown status to the neutral grey, which would make a DEMO pill blend into
// real specs — so we special-case `demo` here with the accent token rather than touch
// the shared statusStyles map (this component owns the demo affordance's look).
const DEMO_CLASSES = 'bg-accent/15 text-accent border-accent/40';

export function Badge({ status, label, className = '' }: BadgeProps) {
  const palette = status === 'demo' ? DEMO_CLASSES : statusClasses(status);
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium border px-1.5 py-0.5 text-[11px] leading-none ${palette} ${className}`}
    >
      {label ?? status.replace(/_/g, ' ')}
    </span>
  );
}
