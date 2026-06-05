import { useState } from 'react';

interface InsertSectionDividerProps {
  onInsert: () => void;
}

export function InsertSectionDivider({ onInsert }: InsertSectionDividerProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative h-8 flex items-center group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Invisible hover zone */}
      <div className="absolute inset-0" />

      {/* Line + button */}
      <div
        className={`
          w-full flex items-center transition-opacity duration-150
          ${hovered ? 'opacity-100' : 'opacity-0'}
        `}
      >
        <div className="flex-1 h-px bg-accent/30" />
        <button
          onClick={onInsert}
          className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium
                     text-accent bg-accent/10 border border-accent/30
                     hover:bg-accent/20 hover:border-accent/50 hover:text-accent-hover
                     transition-colors whitespace-nowrap"
        >
          <PlusIcon />
          Add section
        </button>
        <div className="flex-1 h-px bg-accent/30" />
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}
