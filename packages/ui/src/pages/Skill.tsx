// spec-300 t-6 — the single-skill detail view. Renders:
//   • the verbatim SKILL.md as markdown, with `[per std-N]` cites linkified to
//     the Standard they reference (ac-12);
//   • the capability-flag chips;
//   • the auxiliary-file list (path/type/size), each openable via the server's
//     file endpoint (inline text or a signed URL, ac-16);
//   • a short "Usage" note — how an agent picks the skill up (its canonical ref).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeHighlight from 'rehype-highlight';
import {
  fetchSkill,
  fetchSkillFile,
  type SkillView,
  type SkillFileTocEntry,
} from '../api/skills';
import { ApiError } from '../api/errors';
import { Spinner } from '../components/Spinner';
import { PageHeader } from '../components/PageHeader';
import { CapabilityChips } from '../components/skills/CapabilityChips';
import { encodeStandardRefs, StandardRefLink } from '../components/skills/StandardRefLink';

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

function AuxFileRow({ handle, file }: { handle: string; file: SkillFileTocEntry }) {
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
      {error && <span className="text-[11px] text-status-danger-text flex-none">{error}</span>}
    </li>
  );
}

export function Skill() {
  const { id } = useParams<{ id: string }>();
  const [skill, setSkill] = useState<SkillView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      {/* Auxiliary files */}
      {skill.files.length > 0 && (
        <section className="mb-6" data-testid="skill-files">
          <h2 className="text-sm font-semibold text-heading mb-2">Auxiliary files</h2>
          <ul className="space-y-1.5">
            {skill.files.map((f) => (
              <AuxFileRow key={f.path} handle={skill.handle} file={f} />
            ))}
          </ul>
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
    </div>
  );
}
