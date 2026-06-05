import { type HTMLAttributes } from 'react';

type CardVariant = 'panel' | 'listItem' | 'interactive';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  selected?: boolean;
}

const variantClasses: Record<CardVariant, string> = {
  panel:       'p-5 bg-panel border border-edge rounded-lg',
  listItem:    'px-3 py-2.5 rounded-md bg-surface/50 border border-edge-subtle hover:bg-card-hover',
  interactive: 'px-3 py-2 rounded-lg bg-surface/50 border border-edge-subtle hover:border-edge cursor-pointer transition-colors',
};

const selectedClasses = 'border-edge-strong bg-selected shadow-lg';

export function Card({ variant = 'panel', selected, className = '', children, ...props }: CardProps) {
  return (
    <div
      className={`${variantClasses[variant]} ${selected ? selectedClasses : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
