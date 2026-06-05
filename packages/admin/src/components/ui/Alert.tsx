import { statusClasses } from '../../utils/statusStyles';
import type { ReactNode } from 'react';

// Inline alert/notice block. Wraps the duplicated error/success markup found across the
// auth-flow pages (Signup, LoginScreen, ResetPassword, VerifyEmail, MagicLinkConsume,
// InviteAccept, NewMissionModal, account/{Settings,Users,Invites}Tab) and the share modal.
//
// Variant maps to the same status palette used by Badge, so colours stay consistent across
// the app's chrome.

export type AlertVariant = 'danger' | 'success' | 'info' | 'warning' | 'neutral';

const VARIANT_TO_STATUS: Record<AlertVariant, string> = {
  danger: 'error',
  success: 'resolved',
  info: 'in_progress',
  warning: 'open',
  neutral: 'pending',
};

const SIZE_CLASSES = {
  sm: 'text-xs',
  md: 'text-sm',
} as const;

interface AlertProps {
  variant?: AlertVariant;
  size?: keyof typeof SIZE_CLASSES;
  children: ReactNode;
  className?: string;
}

export function Alert({
  variant = 'danger',
  size = 'sm',
  children,
  className = '',
}: AlertProps) {
  const palette = statusClasses(VARIANT_TO_STATUS[variant]);
  return (
    <div
      role={variant === 'danger' ? 'alert' : 'status'}
      className={`px-3 py-2 rounded-lg border ${palette} ${SIZE_CLASSES[size]} ${className}`}
    >
      {children}
    </div>
  );
}
