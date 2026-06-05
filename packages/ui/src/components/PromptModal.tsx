import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { rehypeRefLinkifier } from './chat/refLinkifier';
import { Button } from './ui';

interface PromptModalProps {
  prompt: string | null;
  loading: boolean;
  onClose: () => void;
  title?: string;
}

export function PromptModal({ prompt, loading, onClose, title = 'Implementation Prompt' }: PromptModalProps) {
  const [editableText, setEditableText] = useState('');
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (prompt) {
      setEditableText(prompt);
      setMode('preview');
    }
  }, [prompt]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(editableText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[720px] max-h-[85vh] flex flex-col rounded-xl border border-edge bg-panel shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-edge">
          <h2 className="text-sm font-semibold text-heading">{title}</h2>
          <div className="flex items-center gap-2">
            {!loading && prompt && (
              <>
                <div className="flex rounded-lg border border-edge overflow-hidden">
                  <button
                    onClick={() => setMode('preview')}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      mode === 'preview'
                        ? 'bg-overlay text-primary'
                        : 'text-muted hover:text-secondary'
                    }`}
                  >
                    Preview
                  </button>
                  <button
                    onClick={() => setMode('edit')}
                    className={`px-3 py-1 text-xs font-medium transition-colors border-l border-edge ${
                      mode === 'edit'
                        ? 'bg-overlay text-primary'
                        : 'text-muted hover:text-secondary'
                    }`}
                  >
                    Edit
                  </button>
                </div>
                <Button size="sm" onClick={handleCopy}>
                  {copied ? 'Copied!' : 'Copy'}
                </Button>
              </>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-md text-muted hover:text-primary hover:bg-overlay transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
          {loading && (
            <div className="flex items-center gap-3 text-sm text-muted py-12 justify-center">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Generating implementation prompt...
            </div>
          )}

          {!loading && prompt && mode === 'preview' && (
            <div className="prose prose-sm prose-invert prose-slate max-w-none text-sm
              [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
              [&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1
              [&_h1]:mt-5 [&_h1]:mb-3 [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:mt-3 [&_h3]:mb-2
              [&_blockquote]:my-3 [&_pre]:my-3">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight, rehypeRefLinkifier]}
              >
                {editableText}
              </ReactMarkdown>
            </div>
          )}

          {!loading && prompt && mode === 'edit' && (
            <textarea
              value={editableText}
              onChange={(e) => setEditableText(e.target.value)}
              className="w-full h-full min-h-[400px] bg-surface/50 border border-edge rounded-lg p-4 text-sm text-primary font-mono resize-none focus:outline-none focus:border-accent"
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
