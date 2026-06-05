import { useState } from 'react';
import type { Comment, DocSection } from '../api/types';
import { splitSection as apiSplitSection } from '../api/client';
import { CommentTray } from './CommentTray';
import { Button } from './ui';

interface SectionInspectorProps {
  section: DocSection;
  sectionNumber: number;
  comments: Comment[];
  onSplit?: (originalId: string, newSections: DocSection[]) => void;
  onCommentsChange?: (sectionId: string, comments: Comment[]) => void;
  onClose: () => void;
}

export function SectionInspector({
  section,
  sectionNumber,
  comments,
  onSplit,
  onCommentsChange,
  onClose,
}: SectionInspectorProps) {
  const [splitting, setSplitting] = useState(false);
  const [confirmSplit, setConfirmSplit] = useState(false);

  const title = section.title || capitalize(section.sectionType);
  const hasHeadings = /^#{1,6}\s/m.test(section.content);

  const handleSplitConfirm = async () => {
    if (splitting || !onSplit) return;
    setConfirmSplit(false);
    setSplitting(true);
    try {
      const newSections = await apiSplitSection(section.id);
      onSplit(section.id, newSections);
    } catch (err) {
      console.error('Split failed:', err);
    } finally {
      setSplitting(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-none px-4 py-3 border-b border-edge">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono text-muted">Section {sectionNumber}</span>
          <button
            onClick={onClose}
            className="text-muted hover:text-primary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <h3 className="text-sm font-medium text-primary mt-1 truncate">{title}</h3>
      </div>

      {/* Actions */}
      <div className="flex-none px-4 py-3 border-b border-edge flex gap-2">
        <button
          onClick={() => {
            // TODO: wire up edit
          }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-primary
                     bg-overlay border border-edge
                     hover:bg-card-hover hover:text-heading hover:border-edge-strong
                     transition-colors"
        >
          <PencilIcon />
          Edit
        </button>

        {hasHeadings && !confirmSplit && (
          <button
            onClick={() => setConfirmSplit(true)}
            disabled={splitting}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs
                       bg-overlay border border-edge
                       hover:bg-card-hover hover:text-heading hover:border-edge-strong
                       transition-colors
                       ${splitting ? 'text-muted cursor-wait' : 'text-primary'}`}
          >
            <SplitIcon />
            {splitting ? 'Splitting...' : 'Split'}
          </button>
        )}

        {confirmSplit && (
          <div className="flex items-center gap-1.5">
            <Button
              onClick={handleSplitConfirm}
              variant="success"
              size="sm"
            >
              Confirm
            </Button>
            <Button
              onClick={() => setConfirmSplit(false)}
              variant="secondary"
              size="sm"
            >
              Cancel
            </Button>
          </div>
        )}
      </div>

      {/* Comments */}
      <div className="flex-1 min-h-0">
        <CommentTray
          targetType="section"
          targetId={section.id}
          comments={comments}
          onCommentsChange={onCommentsChange}
        />
      </div>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M12 3v7m0 4v7" />
    </svg>
  );
}

function capitalize(s: string): string {
  return s
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
