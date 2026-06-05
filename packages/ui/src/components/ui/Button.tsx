import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'agent';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
}

const variantClasses: Record<Variant, string> = {
  primary:   'bg-btn-primary hover:bg-btn-primary-hover text-white',
  secondary: 'bg-btn-secondary hover:bg-btn-secondary-hover text-primary',
  danger:    'bg-status-danger-bg hover:bg-status-danger-border text-status-danger-text',
  ghost:     'bg-transparent text-muted hover:text-secondary',
  success:   'bg-status-success-border hover:bg-status-success-text text-white',
  agent:     'bg-agent hover:bg-agent-hover text-white',
};

const sizeClasses: Record<'sm' | 'md', string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', children, ...props }, ref) => (
    <button
      ref={ref}
      className={`font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
);
Button.displayName = 'Button';
