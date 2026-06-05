import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface SpecMenuItem {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface SpecMenuProps {
  items: SpecMenuItem[];
  align?: 'left' | 'right';
  size?: 'sm' | 'md';
  buttonClassName?: string;
  ariaLabel?: string;
}

// Reusable ⋯ dropdown used for Spec-level actions on both the Kanban card and the
// spec page header. The menu body portals into document.body so it escapes the
// card's `overflow: hidden` and the resizable-panels transform-containing block.
//
// Items are supplied by the parent so the same menu can host a different set depending
// on where it's rendered (e.g. the header also surfaces Download MD / Spec Coding
// Agent alongside the four Spec-level actions).
export function SpecMenu({
  items,
  align = 'right',
  size = 'md',
  buttonClassName,
  ariaLabel = 'Spec actions',
}: SpecMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const top = rect.bottom + 4;
    const menuWidth = 200;
    const left = align === 'right' ? rect.right - menuWidth : rect.left;
    setMenuPos({ top, left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sizeClass = size === 'sm' ? 'w-6 h-6' : 'w-7 h-7';
  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={
          buttonClassName ??
          `inline-flex items-center justify-center rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors ${sizeClass}`
        }
      >
        <svg className={iconSize} viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>
      </button>

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: menuPos.top, left: menuPos.left }}
            className="fixed z-50 w-[200px] rounded-lg border border-edge bg-panel shadow-xl py-1"
          >
            {items.map((item, i) => (
              <div key={`${item.label}-${i}`}>
                {item.separatorBefore && i > 0 && (
                  <div className="my-1 border-t border-edge-subtle" />
                )}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (item.disabled) return;
                    setOpen(false);
                    item.onClick();
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                    item.disabled
                      ? 'text-muted opacity-50 cursor-not-allowed'
                      : item.danger
                      ? 'text-status-danger-text hover:bg-status-danger-bg'
                      : 'text-secondary hover:text-primary hover:bg-overlay'
                  }`}
                >
                  {item.icon && <span className="flex-none w-4 h-4">{item.icon}</span>}
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
