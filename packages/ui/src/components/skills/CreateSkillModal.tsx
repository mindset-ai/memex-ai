// spec-300 t-6 — the create-a-skill modal. Three ways in:
//
//   • Upload    — pick a SKILL.md file; its text fills the editor and validation
//                 errors from the server surface inline on submit.
//   • Write     — the in-app Markdown editor (the shared design-system TextArea,
//                 the same primitive Spec authoring uses) for the SKILL.md text.
//   • Describe  — agent-assisted authoring (ac-21 / ac-49): describe the skill in
//                 plain language and the agent drafts a spec-compliant SKILL.md
//                 (POST /skills/draft → describe→draft→validate, t-15 Increment 1).
//                 The validated draft loads into the editor for review, then the
//                 ordinary create path persists it on confirm.
//
// Capability flags (dec-20) are three checkboxes; auxiliary files (text + binary)
// are staged by <AuxiliaryFilesPanel>. On submit everything POSTs via createSkill.

import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { createSkill, draftSkill, EMPTY_CAPABILITIES, type SkillCapabilities } from '../../api/skills';
import { tenantPath } from '../../utils/tenantUrl';
import { Alert } from '../ui/Alert';
import { Button, TextArea } from '../ui';
import { CAPABILITY_CHIPS } from './capabilities';
import { AuxiliaryFilesPanel, type StagedFile } from './AuxiliaryFilesPanel';

type Mode = 'upload' | 'write' | 'describe';

const MODES: ReadonlyArray<{ id: Mode; label: string }> = [
  { id: 'upload', label: 'Upload SKILL.md' },
  { id: 'write', label: 'Write it' },
  { id: 'describe', label: 'Describe it' },
];

const SKILL_MD_PLACEHOLDER = `---
name: my-skill
description: One line on what this skill does and when to use it.
---

# My skill

Steps, context, and guidance the agent should follow.

Cite standards inline like [per std-9] so they link back.
`;

export function CreateSkillModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('upload');
  const [skillMd, setSkillMd] = useState('');
  const [capabilities, setCapabilities] = useState<SkillCapabilities>(EMPTY_CAPABILITIES);
  const [files, setFiles] = useState<ReadonlyArray<StagedFile>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Describe-it (ac-49): the plain-language description and whether the draft turn
  // is in flight. The returned SKILL.md lands in `skillMd`, reviewed in the editor.
  const [description, setDescription] = useState('');
  const [drafting, setDrafting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleCapability = useCallback((key: keyof SkillCapabilities) => {
    setCapabilities((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Switching tabs clears any create-error banner (spec-300 issue-4b): an error
  // from a prior Upload/Write attempt must not read as a fresh failure on another
  // tab (including Describe, whose action is disabled).
  const handleModeChange = useCallback((next: Mode) => {
    setMode(next);
    setError(null);
  }, []);

  // Describe → draft (ac-49, closes ac-21): send the plain-language description to
  // the server describe→draft→validate turn; the validated SKILL.md lands in the
  // editor for review, then the ordinary create path persists it on confirm.
  const handleDraft = useCallback(async () => {
    const trimmed = description.trim();
    if (trimmed.length === 0 || drafting) return;
    setDrafting(true);
    setError(null);
    try {
      const draft = await draftSkill(trimmed);
      setSkillMd(draft.skillMd);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to draft skill.');
    } finally {
      setDrafting(false);
    }
  }, [description, drafting]);

  const handleUpload = useCallback((file: File | undefined) => {
    if (!file) return;
    setError(null);
    const reader = new FileReader();
    reader.onerror = () => setError('Could not read that file. Try again.');
    reader.onload = () => setSkillMd(String(reader.result ?? ''));
    reader.readAsText(file);
  }, []);

  const canSubmit = skillMd.trim().length > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createSkill({
        skillMd,
        capabilities,
        files: files.map(({ path, purpose, contentType, text, contentBase64 }) => ({
          path,
          purpose,
          contentType,
          text,
          contentBase64,
        })),
      });
      // Land on the new skill's detail page.
      navigate(tenantPath(`/skills/${created.handle}`));
      onClose();
    } catch (err) {
      // The server returns its ValidationError message verbatim (bad frontmatter,
      // missing name/description, etc.) — surface it inline (ac requirement).
      setError(err instanceof Error ? err.message : 'Failed to create skill.');
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, skillMd, capabilities, files, navigate, onClose]);

  const editor = useMemo(
    () => (
      <TextArea
        value={skillMd}
        onChange={(e) => setSkillMd(e.target.value)}
        placeholder={SKILL_MD_PLACEHOLDER}
        aria-label="SKILL.md content"
        data-testid="skill-md-editor"
        className="min-h-[16rem] font-mono text-xs leading-relaxed"
        spellCheck={false}
      />
    ),
    [skillMd],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create a skill"
      data-testid="create-skill-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-edge bg-page shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-base font-semibold text-heading">New skill</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-primary transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Mode switch */}
          <div
            className="flex rounded-sm border border-edge overflow-hidden w-fit"
            role="group"
            aria-label="Authoring mode"
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => handleModeChange(m.id)}
                aria-pressed={mode === m.id}
                data-testid={`skill-mode-${m.id}`}
                className={`text-xs px-3 py-1.5 transition-colors ${
                  mode === m.id
                    ? 'bg-card-hover text-heading'
                    : 'text-secondary hover:bg-card-hover'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'upload' && (
            <div className="space-y-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,text/markdown"
                className="sr-only"
                data-testid="skill-md-file-input"
                aria-label="Upload SKILL.md file"
                onChange={(e) => handleUpload(e.target.files?.[0])}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose SKILL.md
              </Button>
              <p className="text-xs text-muted">
                Its contents load into the editor below; tidy up before you create.
              </p>
              {editor}
            </div>
          )}

          {mode === 'write' && <div className="space-y-2">{editor}</div>}

          {mode === 'describe' && (
            <div className="space-y-3" data-testid="skill-describe-panel">
              <div className="rounded-lg border border-dashed border-edge bg-panel p-4 space-y-2">
                <p className="text-sm text-heading font-medium">Draft it with the agent</p>
                <p className="text-xs text-muted">
                  Describe the skill in plain language and the agent drafts a
                  spec-compliant SKILL.md you can refine before creating.
                </p>
                <TextArea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. A skill that reviews a PR for missing tests and suggests the cases to add."
                  aria-label="Describe the skill"
                  data-testid="skill-describe-input"
                  className="min-h-[6rem] text-sm"
                  disabled={drafting}
                />
                <Button
                  type="button"
                  variant="agent"
                  size="sm"
                  onClick={handleDraft}
                  disabled={description.trim().length === 0 || drafting}
                  data-testid="skill-draft-submit"
                >
                  {drafting ? 'Drafting…' : 'Draft with agent'}
                </Button>
              </div>
              {skillMd.trim().length > 0 && (
                <div className="space-y-2" data-testid="skill-draft-review">
                  <p className="text-xs text-muted">
                    Review the draft and edit as needed, then create the skill.
                  </p>
                  {editor}
                </div>
              )}
            </div>
          )}

          {/* Capability flags */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-heading">Capabilities</legend>
            <p className="text-xs text-muted">
              What this skill expects to touch. Informs routing; enforces nothing.
            </p>
            <div className="space-y-1.5">
              {CAPABILITY_CHIPS.map((chip) => (
                <label key={chip.key} className="flex items-start gap-2 text-sm text-primary">
                  <input
                    type="checkbox"
                    checked={capabilities[chip.key]}
                    onChange={() => toggleCapability(chip.key)}
                    data-testid={`capability-${chip.key}`}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{chip.label}</span>
                    <span className="text-muted"> — {chip.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Auxiliary files (text + binary) */}
          <AuxiliaryFilesPanel files={files} onChange={setFiles} disabled={submitting} />

          {error && (
            <div data-testid="create-skill-error">
              <Alert variant="danger">{error}</Alert>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="create-skill-submit"
          >
            {submitting ? 'Creating…' : 'Create skill'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
