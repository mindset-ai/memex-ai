import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DocRole } from '../api/client';

// The header pill chrome — shared with the header's other pill controls (the
// Share button in DocDocument) so the header reads as one uniform family.
export const HEADER_PILL_CLASS =
  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-btn-secondary hover:bg-btn-secondary-hover text-sm text-primary transition-colors';

interface PostureDropdownProps {
  /** The viewer's current posture on this Spec (from useDocRole). */
  myRole: DocRole;
  /** Called with the target posture when the user picks the OTHER mode. */
  onSelect: (target: DocRole) => void;
}

// Lucide `eye` / `pencil` / `chevron-down` / `check` glyphs (https://lucide.dev),
// inlined to match the codebase's inline-SVG idiom and avoid a new icon
// dependency.
function EyeIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PencilIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// spec-159 ac-19 (amended): the viewer's posture switch — a Google-Docs-style
// mode pill in the page header ("You are editing" / "You are reviewing") with
// a two-option menu (Editing / Reviewing, check on the current mode). This is
// MY posture on the Spec, page-global — distinct from SpecRoleControls, which
// manages who holds which role. It replaced the reviewer block's two-link
// posture sentence ("You are a reviewer… Switch to editing instead.").
//
// Mode vocabulary deliberately differs from the roles row: the pill says
// Editing / Reviewing (what I'm doing), the roles row says Editor / Reviewer
// (who someone is). Selecting the current mode just closes the menu.
//
// Dropdown mechanics (portal into body, outside-click + Escape dismiss) follow
// SpecMenu.
export function PostureDropdown({ myRole, onSelect }: PostureDropdownProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const menuWidth = 256;

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.right - menuWidth });
  }, [open]);

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

  const editing = myRole === 'editor';

  const options: Array<{
    role: DocRole;
    label: string;
    description: string;
    icon: React.ReactNode;
  }> = [
    {
      role: 'editor',
      label: 'Editing',
      description: 'Enable all editing functions',
      icon: <PencilIcon />,
    },
    {
      role: 'reviewer',
      label: 'Reviewing',
      description: 'Read & comment, no direct edits',
      icon: <EyeIcon />,
    },
  ];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={HEADER_PILL_CLASS}
      >
        {editing ? <PencilIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
        {editing ? 'You are editing' : 'You are reviewing'}
        <ChevronDownIcon />
      </button>

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: menuPos.top, left: menuPos.left, width: menuWidth }}
            className="fixed z-50 rounded-lg border border-edge bg-panel shadow-xl py-1"
          >
            {options.map((opt) => {
              const current = opt.role === myRole;
              return (
                <button
                  key={opt.role}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                    if (!current) onSelect(opt.role);
                  }}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-overlay transition-colors"
                >
                  <span className="mt-0.5 text-primary">{opt.icon}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium text-primary">{opt.label}</span>
                    <span className="block text-xs text-muted">{opt.description}</span>
                  </span>
                  {current && (
                    <span className="mt-0.5 text-primary">
                      <CheckIcon />
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
