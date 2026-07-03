// spec-300 t-6 — the auxiliary-files panel for the create flow. A skill can bundle
// supporting files alongside its SKILL.md: text (templates, snippets) AND binary
// (fonts, images). This panel stages picked files, classifies each as text or
// binary, and hands the parent an array of SkillFileUpload payloads to POST.
//
// Text files ride inline as `text`; binary files ride as base64 `contentBase64`
// (JSON can't carry raw bytes). The server splits them back into inline vs blob
// storage — the client just has to encode correctly (ac-14).

import { useCallback, useRef, useState } from 'react';
import type { SkillFileUpload } from '../../api/skills';
import { Button } from '../ui';

/** A file staged for upload — the wire payload plus a display size. */
export interface StagedFile extends SkillFileUpload {
  readonly size: number;
  readonly binary: boolean;
}

// A file counts as text when its MIME type is textual or a known text-ish
// application type (json/xml/yaml/markdown). Everything else — fonts, images,
// archives — is treated as binary and base64-encoded. When the browser reports
// no type (some .md drops), fall back to the extension.
const TEXT_MIME = /^text\//;
const TEXT_APPLICATION = /^application\/(json|xml|.*\+xml|x-yaml|yaml|.*\+json)$/;
const TEXT_EXTENSIONS = /\.(md|markdown|txt|json|ya?ml|xml|csv|html?|css|jsx?|tsx?|py|sh|toml|ini)$/i;

export function isTextFile(file: File): boolean {
  if (file.type) {
    if (TEXT_MIME.test(file.type) || TEXT_APPLICATION.test(file.type)) return true;
    // A declared non-text MIME (image/font/etc.) is binary regardless of name.
    return false;
  }
  return TEXT_EXTENSIONS.test(file.name);
}

/** Strip the `data:<mime>;base64,` prefix a FileReader data URL carries. */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file);
  });
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => resolve(stripDataUrlPrefix(String(reader.result ?? '')));
    reader.readAsDataURL(file);
  });
}

/** Read one picked File into a staged upload payload (text or base64 binary). */
export async function stageFile(file: File): Promise<StagedFile> {
  const path = file.name;
  const contentType = file.type || 'application/octet-stream';
  if (isTextFile(file)) {
    const text = await readAsText(file);
    return { path, contentType: file.type || 'text/plain', text, size: file.size, binary: false };
  }
  const contentBase64 = await readAsBase64(file);
  return { path, contentType, contentBase64, size: file.size, binary: true };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AuxiliaryFilesPanel({
  files,
  onChange,
  disabled = false,
}: {
  files: ReadonlyArray<StagedFile>;
  onChange: (next: ReadonlyArray<StagedFile>) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePick = useCallback(
    async (picked: FileList | null) => {
      if (!picked || picked.length === 0) return;
      setError(null);
      try {
        const staged = await Promise.all(Array.from(picked).map(stageFile));
        // De-dupe by path: a re-picked path replaces the earlier stage.
        const byPath = new Map(files.map((f) => [f.path, f]));
        for (const s of staged) byPath.set(s.path, s);
        onChange(Array.from(byPath.values()));
      } catch {
        setError('Could not read one of the files. Try again.');
      } finally {
        // Reset so re-picking the same file re-fires onChange.
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [files, onChange],
  );

  const removeAt = useCallback(
    (path: string) => onChange(files.filter((f) => f.path !== path)),
    [files, onChange],
  );

  return (
    <div data-testid="aux-files-panel">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm font-medium text-heading">Auxiliary files</p>
          <p className="text-xs text-muted">
            Optional. Templates, snippets, fonts, or images the skill needs. Text and
            binary both welcome.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Add files
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        data-testid="aux-file-input"
        aria-label="Add auxiliary files"
        disabled={disabled}
        onChange={(e) => handlePick(e.target.files)}
      />

      {error && (
        <p className="text-xs text-status-danger-text mb-2" role="alert">
          {error}
        </p>
      )}

      {files.length > 0 && (
        <ul className="space-y-1.5" data-testid="aux-file-list">
          {files.map((f) => (
            <li
              key={f.path}
              data-testid="aux-file-row"
              data-binary={f.binary ? 'true' : 'false'}
              className="flex items-center gap-2 rounded-md border border-edge-subtle bg-panel px-2.5 py-1.5"
            >
              <span className="font-mono text-xs text-primary truncate flex-1">{f.path}</span>
              <span className="text-[11px] text-muted flex-none">
                {f.binary ? 'binary' : 'text'} · {formatBytes(f.size)}
              </span>
              <button
                type="button"
                onClick={() => removeAt(f.path)}
                disabled={disabled}
                aria-label={`Remove ${f.path}`}
                className="flex-none text-xs text-muted hover:text-status-danger-text transition-colors"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
