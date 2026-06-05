// spec-118 t-6 — the per-Spec posture + assignment control on the Spec header.
//
// Two affordances, both additive and frictionless (dec-5 / dec-3):
//   • Posture switch — a one-click "Switch to editing" / "Switch to reviewing"
//     toggle (no confirmation). Self-promote/demote route to the session user
//     server-side, so the client needs no user id.
//   • Assignment — the live assignees (avatars + remove ✕) and an "Assign me"
//     action. Assignment is independent of role (assigning never changes posture).
//
// Only an org member with write access sees the mutating affordances; everyone
// reads the posture badge + assignees (the controls gate on `canWrite`).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDocAssignees,
  assignUser,
  unassignUser,
  promoteToEditor,
  demoteToReviewer,
  listTeamMembersApi,
  type DocAssigneeView,
  type TeamMemberDto,
} from '../api/client';
import { useDocRole } from '../hooks/useDocRole';
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

export function SpecRoleControls({ docId }: { docId: string }) {
  const { canWrite } = useMemexAccess();
  const { token } = useAuth();
  const { myRole, refetch: refetchRole } = useDocRole(docId);
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

  // The org roster powers the "Assign someone" picker. Loaded lazily the first
  // time the picker opens (only members with write access ever open it), so a
  // reviewer's read of the badge + chips never fires this request.
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

  const isEditor = myRole === 'editor';

  const togglePosture = useCallback(async () => {
    setBusy(true);
    try {
      if (isEditor) await demoteToReviewer(docId);
      else await promoteToEditor(docId);
      refetchRole();
    } finally {
      setBusy(false);
    }
  }, [isEditor, docId, refetchRole]);

  const assignMe = useCallback(async () => {
    setBusy(true);
    try {
      await assignUser(docId);
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

  return (
    <div className="flex items-center gap-4 flex-wrap" data-testid="spec-role-controls">
      {/* Posture badge + one-click switch */}
      <div className="flex items-center gap-2">
        <span
          data-testid="spec-role-badge"
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
            isEditor ? 'bg-overlay text-heading' : 'bg-surface text-muted'
          }`}
        >
          {isEditor ? 'Editor' : 'Reviewer'}
        </span>
        {canWrite && (
          <button
            type="button"
            onClick={togglePosture}
            disabled={busy}
            className="text-xs text-secondary hover:text-primary underline-offset-2 hover:underline disabled:opacity-50"
          >
            {isEditor ? 'Switch to reviewing' : 'Switch to editing'}
          </button>
        )}
      </div>

      {/* Assignees + assign control */}
      <div className="flex items-center gap-2" data-testid="spec-assign-control">
        <span className="text-xs text-muted">Assignees</span>
        {assignees.length === 0 && <span className="text-xs text-muted/70 italic">Unassigned</span>}
        <div className="flex items-center gap-1">
          {assignees.map((a) => {
            const label = personLabel(a);
            return (
              <span
                key={a.userId}
                className="inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-full bg-overlay border border-edge text-[11px] text-heading"
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
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={assignMe}
            disabled={busy}
            className="text-xs text-secondary hover:text-primary underline-offset-2 hover:underline disabled:opacity-50"
          >
            Assign me
          </button>
        )}
        {/* Assign someone else: a member picker over the org roster. Already-
            assigned members are filtered out so the list is "who can I still
            add". Picks call assignUser(docId, userId) — assignment is
            independent of role (dec-3). */}
        {canWrite && (
          <div className="relative" ref={pickerRef} data-testid="spec-assign-picker">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              disabled={busy}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              className="text-xs text-secondary hover:text-primary underline-offset-2 hover:underline disabled:opacity-50"
            >
              Assign someone
            </button>
            {pickerOpen && (
              <div
                role="listbox"
                className="absolute z-10 mt-1 max-h-60 w-56 overflow-y-auto rounded-md border border-edge bg-panel py-1 shadow-lg"
              >
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
      </div>
    </div>
  );
}
