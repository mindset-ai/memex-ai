// spec-343: "raw + formatted" markdown rendering for the composed prompt.
//
// The scaffold shows the EXACT prompt string the agent receives — it must not
// be converted to clean HTML (that would hide what's really sent). But a wall
// of plain text is hard to read. So this renders the hybrid modern editors use
// (Obsidian Live Preview / IDE markdown): the literal syntax markers stay
// visible but dimmed, while the content they decorate is styled. `# Heading`
// shows the `#` and reads as a heading; `**bold**` shows the asterisks and is
// bold; `` `code` `` shows the backticks and is monospaced.
//
// Deliberately tiny and dependency-free (no markdown lib). It supports exactly
// what the scaffold prose uses: ATX headings, `-`/`*`/`N.` list markers, fenced
// code blocks, inline `**bold**` and `` `code` ``. Underscore italics are NOT
// parsed — snake_case identifiers (create_task, org_scaffold_additions) would
// be mangled — so underscores render literally.

import { Fragment, type ReactNode } from 'react';

const MARKER = 'text-muted/70';

/** Inline pass — keeps `**…**` and `` `…` `` markers visible, styles the inner
 *  content. Everything else renders literally (so `<list>`, snake_case, etc.
 *  are untouched). */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+?\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      out.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last, match.index)}</Fragment>);
    }
    const tok = match[0];
    if (tok.startsWith('`')) {
      const inner = tok.slice(1, -1);
      out.push(
        <code
          key={`${keyBase}-c${i++}`}
          className="rounded-sm bg-overlay px-1 py-0.5 font-mono text-[0.9em] text-primary"
        >
          <span className={MARKER}>`</span>
          {inner}
          <span className={MARKER}>`</span>
        </code>,
      );
    } else {
      const inner = tok.slice(2, -2);
      out.push(
        <strong key={`${keyBase}-b${i++}`} className="font-semibold text-primary">
          <span className={`${MARKER} font-normal`}>**</span>
          {inner}
          <span className={`${MARKER} font-normal`}>**</span>
        </strong>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last)}</Fragment>);
  return out;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[15px] font-semibold text-heading',
  2: 'text-sm font-semibold text-heading',
  3: 'text-sm font-medium text-heading',
};

function Line({ line, k }: { line: string; k: string }) {
  // Blank line → paragraph gap.
  if (line.trim() === '') return <div className="h-2" aria-hidden="true" />;

  // ATX heading: keep the # markers, style the text.
  const heading = /^(#{1,6})(\s+)(.*)$/.exec(line);
  if (heading) {
    const level = heading[1].length;
    return (
      <div className={HEADING_CLASS[level] ?? HEADING_CLASS[3]}>
        <span className={`${MARKER} font-normal`}>{heading[1]}</span>
        {heading[2]}
        {renderInline(heading[3], k)}
      </div>
    );
  }

  // Bullet list: keep the - / * marker dimmed.
  const bullet = /^(\s*)([-*])(\s+)(.*)$/.exec(line);
  if (bullet) {
    return (
      <div className="flex">
        <span className="whitespace-pre">{bullet[1]}</span>
        <span className={MARKER}>{bullet[2]}</span>
        <span className="whitespace-pre">{bullet[3]}</span>
        <span className="flex-1">{renderInline(bullet[4], k)}</span>
      </div>
    );
  }

  // Ordered list: keep the "N." marker dimmed.
  const ordered = /^(\s*)(\d+\.)(\s+)(.*)$/.exec(line);
  if (ordered) {
    return (
      <div className="flex">
        <span className="whitespace-pre">{ordered[1]}</span>
        <span className={MARKER}>{ordered[2]}</span>
        <span className="whitespace-pre">{ordered[3]}</span>
        <span className="flex-1">{renderInline(ordered[4], k)}</span>
      </div>
    );
  }

  // Plain paragraph.
  return <div>{renderInline(line, k)}</div>;
}

export function MarkdownText({ text }: { text: string }) {
  const rows: ReactNode[] = [];
  const lines = text.split('\n');
  let inFence = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (/^\s*```/.test(line)) {
      // Fence marker — keep it visible, dimmed.
      inFence = !inFence;
      rows.push(
        <div key={`f${idx}`} className={`${MARKER} font-mono text-[0.9em]`}>
          {line}
        </div>,
      );
      continue;
    }
    if (inFence) {
      // Inside a code block — render verbatim, no inline parsing.
      rows.push(
        <div key={`p${idx}`} className="whitespace-pre-wrap wrap-break-word font-mono text-[0.9em] text-primary">
          {line === '' ? ' ' : line}
        </div>,
      );
      continue;
    }
    rows.push(<Line key={`l${idx}`} line={line} k={`l${idx}`} />);
  }
  return <div className="text-sm leading-relaxed text-primary/90 wrap-break-word">{rows}</div>;
}
