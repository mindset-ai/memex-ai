import { forwardRef, type InputHTMLAttributes } from 'react';

type InputSize = 'compact' | 'full';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: InputSize;
}

const sizeClasses: Record<InputSize, string> = {
  compact: 'px-2 py-1 text-xs rounded',
  full:    'px-3 py-2 text-sm rounded-lg',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ inputSize = 'full', className = '', ...props }, ref) => (
    <input
      ref={ref}
      className={`w-full bg-input border border-edge text-primary placeholder-muted focus:outline-none focus:ring-1 focus:ring-edge-strong focus:border-edge-strong ${sizeClasses[inputSize]} ${className}`}
      {...props}
    />
  )
);
Input.displayName = 'Input';
