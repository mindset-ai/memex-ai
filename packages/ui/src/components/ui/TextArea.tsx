import { forwardRef, type TextareaHTMLAttributes } from 'react';

type TextAreaSize = 'compact' | 'full';

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  textAreaSize?: TextAreaSize;
}

const sizeClasses: Record<TextAreaSize, string> = {
  compact: 'px-2.5 py-1.5 text-sm rounded',
  full:    'px-3 py-2 text-sm rounded-lg',
};

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ textAreaSize = 'full', className = '', ...props }, ref) => (
    <textarea
      ref={ref}
      className={`w-full bg-input border border-edge text-primary placeholder-muted focus:outline-none focus:ring-1 focus:ring-edge-strong focus:border-edge-strong resize-none ${sizeClasses[textAreaSize]} ${className}`}
      {...props}
    />
  )
);
TextArea.displayName = 'TextArea';
