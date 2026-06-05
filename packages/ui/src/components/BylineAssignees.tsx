// spec-159 — Spec assignment, on the byline.
//
// Assignment moved off the old SpecRoleControls row (whose posture switching is
// handled elsewhere) and onto the Spec header's byline: the live assignee chips
// (avatars + remove ✕) followed by a single "+ Assign" pill. The pill opens ONE
// dropdown that folds the former "Assign me" + "Assign someone" into a single
// list — "Assign me" first, then the org roster minus already-assigned members.
//
// Assignment is independent of role (assigning never changes posture, dec-3).
// Only an org member with write access sees the mutating affordances; read-only
// visitors see the chips (or nothing when unassigned). Behaviour is ported from
// the original SpecRoleControls assignment block — identical API calls, identical
// live-refresh + lazy-roster + outside-click-to-close patterns.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchDocAssignees,
  assignUser,
  unassignUser,
  listTeamMembersApi,
  type DocAssigneeView,
  type TeamMemberDto,
} from '../api/client';
import { useMemexAccess } from '../hooks/useMemexAccess';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { useAuth } from './AuthContext';

function personLabel(a: { name: string | null; email: string | null }): string {
  return a.name?.trim() || a.email?.trim() || 'Unknown';
}
function initials(label: string): string {
  const parts = label.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function BylineAssignees({ docId }: { docId: string }) {
  const { canWrite } = useMemexAccess();
  const { token, user } = useAuth();
  const [assignees, setAssignees] = useState<DocAssigneeView[]>([]);
  const [members, setMembers] = useState<TeamMemberDto[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const loadAssignees = useCallback(() => {
    fetchDocAssignees(docId)
      .then(setAssignees)
      .catch(() => setAssignees([]));
  }, [docId]);

  useEffect(() => {
    loadAssignees();
  }, [loadAssignees]);
  // Live: assignment changes (a 'doc_assignee' event) refresh the chips.
  useDocChangeStream(docId, loadAssignees);

  // The org roster powers the picker. Loaded lazily the first time the picker
  // opens (only members with write access ever open it), so a reviewer's read of
  // the chips never fires this request.
  useEffect(() => {
    if (!pickerOpen || members.length > 0) return;
    listTeamMembersApi(token)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [pickerOpen, members.length, token]);

  // Close the picker on an outside click so it behaves like a normal dropdown.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [pickerOpen]);

  const assignMe = useCallback(async () => {
    setBusy(true);
    try {
      await assignUser(docId); // no userId → server uses the session user
      setPickerOpen(false);
      loadAssignees();
    } finally {
      setBusy(false);
    }
  }, [docId, loadAssignees]);

  const assignMember = useCallback(
    async (userId: string) => {
      setBusy(true);
      try {
        await assignUser(docId, userId);
        setPickerOpen(false);
        loadAssignees();
      } finally {
        setBusy(false);
      }
    },
    [docId, loadAssignees],
  );

  const removeAssignee = useCallback(
    async (userId: string) => {
      setBusy(true);
      try {
        await unassignUser(docId, userId);
        loadAssignees();
      } finally {
        setBusy(false);
      }
    },
    [docId, loadAssignees],
  );

  // Is the session user already an assignee? AuthContext exposes the user's id
  // (and email as a fallback), so we can hide the "Assign me" row once they're on
  // the list. If we can't match (no identity), we leave it shown — assignUser is
  // idempotent server-side, so a redundant self-assign is harmless.
  const alreadyAssignedToMe = useMemo(() => {
    if (!user) return false;
    return assignees.some(
      (a) =>
        (user.id && a.userId === user.id) ||
        (user.email && a.email?.toLowerCase() === user.email.toLowerCase()),
    );
  }, [assignees, user]);

  const hasChips = assignees.length > 0;

  // Read-only visitor with no assignees: render nothing (no placeholder).
  if (!canWrite && !hasChips) return null;

  return (
    <span className="inline-flex items-center gap-1.5" data-testid="byline-assignees">
      {assignees.map((a) => {
        const label = personLabel(a);
        return (
          <span
            key={a.userId}
            className="inline-flex h-6 items-center gap-1 pl-1 pr-1.5 rounded-full bg-overlay border border-edge text-[11px] leading-none text-heading"
            title={label}
          >
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-surface text-[9px]">
              {initials(label)}
            </span>
            {label}
            {canWrite && (
              <button
                type="button"
                onClick={() => removeAssignee(a.userId)}
                disabled={busy}
                aria-label={`Unassign ${label}`}
                className="text-muted hover:text-primary disabled:opacity-50"
              >
                ×
              </button>
            )}
          </span>
        );
      })}

      {/* One "+ Assign" pill → one dropdown: "Assign me" first, then the roster
          minus already-assigned members. Replaces the old "Assign me" +
          "Assign someone" pair. */}
      {canWrite && (
        <div className="relative" ref={pickerRef} data-testid="byline-assign-picker">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            disabled={busy}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            className="inline-flex h-6 items-center px-2 rounded-full border border-edge text-[11px] font-medium leading-none text-secondary hover:text-primary hover:bg-overlay disabled:opacity-50"
          >
            + Assign
          </button>
          {pickerOpen && (
            <div
              role="listbox"
              className="absolute z-10 mt-1 max-h-60 w-56 overflow-y-auto rounded-md border border-edge bg-panel py-1 shadow-lg"
            >
              {!alreadyAssignedToMe && (
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={assignMe}
                  disabled={busy}
                  data-testid="byline-assign-me"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-heading hover:bg-overlay disabled:opacity-50"
                >
                  Assign me
                </button>
              )}
              {!alreadyAssignedToMe && <div className="my-1 border-t border-edge" />}
              {(() => {
                const assignedIds = new Set(assignees.map((a) => a.userId));
                const available = members.filter((m) => !assignedIds.has(m.userId));
                if (available.length === 0) {
                  return (
                    <div className="px-3 py-1.5 text-xs text-muted/70 italic">
                      {members.length === 0 ? 'Loading…' : 'Everyone is assigned'}
                    </div>
                  );
                }
                return available.map((m) => (
                  <button
                    key={m.userId}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => assignMember(m.userId)}
                    disabled={busy}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-heading hover:bg-overlay disabled:opacity-50"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-surface text-[9px]">
                      {initials(m.email)}
                    </span>
                    <span className="truncate">{m.email}</span>
                  </button>
                ));
              })()}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
