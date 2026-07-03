// spec-300 t-6 — the single-skill detail view. Renders:
//   • the verbatim SKILL.md as markdown, with `[per std-N]` cites linkified to
//     the Standard they reference (ac-12);
//   • the capability-flag chips;
//   • the auxiliary-file list (path/type/size), each openable via the server's
//     file endpoint (inline text or a signed URL, ac-16);
//   • a short "Usage" note — how an agent picks the skill up (its canonical ref).
//
// spec-300 t-16 (dec-24) — auxiliary-file MANAGEMENT lives here (write access only):
//   • add files by dragging/dropping or picking them (AuxiliaryFilesPanel → editSkill),
//   • remove a file via its X, behind a confirmation guard (RemoveSkillFileDialog).
// The in-app agent no longer attaches files — this page (and a coding agent over MCP)
// is where files are managed. Backend already supports it (issue-7 editSkill files/
// removeFiles); this is the UI surface. Write-gated via useMemexAccess (std-4).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeHighlight from 'rehype-highlight';
import {
  fetchSkill,
  fetchSkillFile,
  editSkill,
  type SkillView,
  type SkillFileTocEntry,
} from '../api/skills';
import { ApiError } from '../api/errors';
import { Spinner } from '../components/Spinner';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui';
import { Alert } from '../components/ui/Alert';
import { CapabilityChips } from '../components/skills/CapabilityChips';
import { AuxiliaryFilesPanel, type StagedFile } from '../components/skills/AuxiliaryFilesPanel';
import { RemoveSkillFileDialog } from '../components/skills/RemoveSkillFileDialog';
import { encodeStandardRefs, StandardRefLink } from '../components/skills/StandardRefLink';
import { useMemexAccess } from '../hooks/useMemexAccess';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeRaw, rehypeHighlight];

// react-markdown's component map is typed strictly; `standardref` is our injected
// element (see encodeStandardRefs), so widen to a record like Standard.tsx does.
const markdownComponents: Record<string, unknown> = {
  standardref: ({ handle }: { handle?: string }) => <StandardRefLink handle={handle} />,
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AuxFileRow({
  handle,
  file,
  canWrite,
  onRemove,
}: {
  handle: string;
  file: SkillFileTocEntry;
  canWrite: boolean;
  onRemove: (file: SkillFileTocEntry) => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async () => {
    setOpening(true);
    setError(null);
    try {
      const access = await fetchSkillFile(handle, file.path);
      if (access.kind === 'bucket') {
        window.open(access.url, '_blank', 'noopener,noreferrer');
      } else {
        // Inline text — open as a blob so the browser shows / downloads it.
        const blob = new Blob([access.text], { type: access.contentType || 'text/plain' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch {
      setError('Could not open file');
    } finally {
      setOpening(false);
    }
  }, [handle, file.path]);

  return (
    <li
      data-testid="skill-file-row"
      className="flex items-center gap-2 rounded-md border border-edge-subtle bg-panel px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs text-primary truncate">{file.path}</p>
        {file.purpose && <p className="text-[11px] text-muted truncate">{file.purpose}</p>}
      </div>
      <span className="text-[11px] text-muted flex-none">
        {file.contentType} · {formatBytes(file.size)}
      </span>
      <button
        type="button"
        onClick={open}
        disabled={opening}
        className="flex-none text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
      >
        {opening ? 'Opening…' : 'Open'}
      </button>
      {canWrite && (
        <button
          type="button"
          onClick={() => onRemove(file)}
          aria-label={`Remove ${file.path}`}
          title="Remove file"
          data-testid="skill-file-remove"
          className="flex-none text-sm leading-none text-muted hover:text-status-danger-text transition-colors"
        >
          ✕
        </button>
      )}
      {error && <span className="text-[11px] text-status-danger-text flex-none">{error}</span>}
    </li>
  );
}

export function Skill() {
  const { id } = useParams<{ id: string }>();
  const { canWrite } = useMemexAccess();
  const [skill, setSkill] = useState<SkillView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // spec-300 t-16 (dec-24): file-management state. `staged` holds files picked for
  // addition; `removing` is the file pending a remove-confirmation; `fileError`
  // surfaces an add/remove failure.
  const [staged, setStaged] = useState<ReadonlyArray<StagedFile>>([]);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<SkillFileTocEntry | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    fetchSkill(id)
      .then((data) => {
        if (cancelled) return;
        setSkill(data);
        setNotFound(false);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError(err instanceof Error ? err.message : 'Failed to load skill');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Re-fetch the skill after an edit so the file TOC reflects the change.
  const reload = useCallback(async () => {
    if (!id) return;
    const data = await fetchSkill(id);
    setSkill(data);
  }, [id]);

  // Add the staged files (text inline / binary base64) through the shared edit
  // path, then reload and clear the stage (ac-54 / ac-57).
  const handleAddFiles = useCallback(async () => {
    if (!id || staged.length === 0 || saving) return;
    setSaving(true);
    setFileError(null);
    try {
      await editSkill(id, {
        files: staged.map(({ path, purpose, contentType, text, contentBase64 }) => ({
          path,
          purpose,
          contentType,
          text,
          contentBase64,
        })),
      });
      setStaged([]);
      await reload();
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Failed to add files.');
    } finally {
      setSaving(false);
    }
  }, [id, staged, saving, reload]);

  // Confirmed removal (the dialog's onConfirm). Removes exactly the file pending
  // confirmation, then reloads (ac-55 / ac-58). Closes the dialog either way.
  const confirmRemove = useCallback(async () => {
    if (!id || !removing) return;
    setFileError(null);
    try {
      await editSkill(id, { removeFiles: [removing.path] });
      await reload();
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Failed to remove file.');
    } finally {
      setRemoving(null);
    }
  }, [id, removing, reload]);

  const encodedBody = useMemo(
    () => (skill ? encodeStandardRefs(skill.skillMd) : ''),
    [skill],
  );

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="px-6 py-8">
        <PageHeader title="Skill not found" />
        <p className="text-sm text-secondary">
          This skill doesn’t exist, or you don’t have access to it.
        </p>
      </div>
    );
  }

  if (error || !skill) {
    return (
      <div className="px-6 py-8">
        <div className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text">
          Failed to load skill: {error ?? 'unknown error'}
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-6 max-w-3xl mx-auto">
      <PageHeader title={skill.name} />

      <div className="flex items-center gap-3 mb-4 text-xs text-muted">
        <span className="font-mono">{skill.handle}</span>
        <CapabilityChips capabilities={skill.capabilities} />
      </div>

      {skill.description && (
        <p className="text-sm text-secondary mb-6">{skill.description}</p>
      )}

      {/* Rendered SKILL.md */}
      <section className="prose-dark overflow-hidden rounded-lg border border-edge-subtle bg-panel px-5 py-4 mb-6">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownComponents as never}
        >
          {encodedBody}
        </ReactMarkdown>
      </section>

      {/* Auxiliary files — the list, plus (write access) add + remove management. */}
      {(skill.files.length > 0 || canWrite) && (
        <section className="mb-6" data-testid="skill-files">
          <h2 className="text-sm font-semibold text-heading mb-2">Auxiliary files</h2>
          {skill.files.length > 0 ? (
            <ul className="space-y-1.5">
              {skill.files.map((f) => (
                <AuxFileRow
                  key={f.path}
                  handle={skill.handle}
                  file={f}
                  canWrite={canWrite}
                  onRemove={setRemoving}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">No auxiliary files yet.</p>
          )}

          {/* spec-300 t-16 (dec-24): add files by drag/drop or picking (write only). */}
          {canWrite && (
            <div className="mt-3 space-y-2" data-testid="skill-add-files">
              <AuxiliaryFilesPanel files={staged} onChange={setStaged} disabled={saving} />
              {staged.length > 0 && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={handleAddFiles}
                  disabled={saving}
                  data-testid="skill-add-files-save"
                >
                  {saving ? 'Adding…' : `Add ${staged.length} file${staged.length === 1 ? '' : 's'}`}
                </Button>
              )}
              {fileError && (
                <div data-testid="skill-file-error">
                  <Alert variant="danger">{fileError}</Alert>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Usage */}
      <section data-testid="skill-usage">
        <h2 className="text-sm font-semibold text-heading mb-2">Usage</h2>
        <p className="text-xs text-secondary mb-2">
          Agents working in this Memex can pick this skill up by its canonical ref.
          Its capability flags inform which agent surfaces it’s offered to.
        </p>
        <code className="block rounded-md border border-edge-subtle bg-panel px-3 py-2 font-mono text-xs text-primary break-all">
          {skill.ref}
        </code>
      </section>

      {/* Remove-file confirmation (fat-finger guard, ac-55). */}
      {removing && (
        <RemoveSkillFileDialog
          path={removing.path}
          onConfirm={confirmRemove}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
