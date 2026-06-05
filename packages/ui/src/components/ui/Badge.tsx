import { statusClasses } from '../../utils/statusStyles';

interface BadgeProps {
  /** Domain status string (draft, active, blocked, etc.) */
  status: string;
  /** Display label. Defaults to status string with underscores replaced. */
  label?: string;
  className?: string;
}

export function Badge({ status, label, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium border px-1.5 py-0.5 text-[11px] leading-none ${statusClasses(status)} ${className}`}
    >
      {label ?? status.replace(/_/g, ' ')}
    </span>
  );
}
