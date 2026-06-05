import type {
  Comment,
  Decision,
  DocSection,
  DocWithGraph,
  Task,
} from '../api/types';

export interface MarkdownOptions {
  includeSections: boolean;
  includeDecisions: boolean;
  includeTasks: boolean;
  includeComments: boolean;
}

export interface CommentMaps {
  bySection: Record<string, Comment[]>;
  byDecision: Record<string, Comment[]>;
  byTask: Record<string, Comment[]>;
}

export function specToMarkdown(
  doc: DocWithGraph,
  comments: CommentMaps,
  options: MarkdownOptions,
): string {
  const sections = [...doc.sections].sort((a, b) => a.seq - b.seq);
  const decisions = [...(doc.decisions ?? [])].sort((a, b) => a.seq - b.seq);
  const tasks = [...(doc.tasks ?? [])].sort((a, b) => a.seq - b.seq);

  const parts: string[] = [renderHeader(doc)];
  if (options.includeSections) {
    parts.push(...sections.map(renderSection));
  }

  if (options.includeDecisions && decisions.length > 0) {
    parts.push(renderDecisions(decisions, options.includeComments ? comments.byDecision : null));
  }
  if (options.includeTasks && tasks.length > 0) {
    parts.push(renderTasks(tasks, decisions, tasks, options.includeComments ? comments.byTask : null));
  }
  if (options.includeComments) {
    const commentSection = renderAllComments(sections, decisions, tasks, comments, {
      includeSectionComments: options.includeSections,
      includeDecisionComments: !options.includeDecisions,
      includeTaskComments: !options.includeTasks,
    });
    if (commentSection) parts.push(commentSection);
  }

  return parts.join('\n\n').trimEnd() + '\n';
}

function renderHeader(doc: DocWithGraph): string {
  return [
    `# ${doc.title}`,
    '',
    `- **Handle:** \`${doc.handle}\``,
    `- **Type:** ${doc.docType}`,
    `- **Status:** ${doc.status}`,
  ].join('\n');
}

function renderSection(section: DocSection, index: number): string {
  const heading = section.title ?? toTitleCase(section.sectionType);
  return `## ${index + 1}. ${heading}\n\n${section.content.trim()}`;
}

function renderDecisions(decisions: Decision[], commentMap: Record<string, Comment[]> | null): string {
  const blocks = decisions.map((d) => {
    const header = `### D-${d.seq}: ${d.title} — ${d.status.toUpperCase()}`;
    const body: string[] = [header];
    if (d.context) body.push('', d.context.trim());
    if (d.status === 'resolved' && d.resolution) {
      body.push('', `**Resolution:** ${d.resolution.trim()}`);
    }
    if (commentMap) {
      const block = renderCommentBlock(commentMap[d.id]);
      if (block) body.push('', block);
    }
    return body.join('\n');
  });
  return ['## Decisions', '', ...blocks].join('\n\n');
}

function renderTasks(
  tasks: Task[],
  _decisions: Decision[],
  _allTasks: Task[],
  commentMap: Record<string, Comment[]> | null,
): string {
  const blocks = tasks.map((t) => {
    const header = `### T-${t.seq}: ${t.title} — ${t.status}${t.blocked ? ' (blocked)' : ''}`;
    const body: string[] = [header];
    if (t.description) body.push('', t.description.trim());
    if (t.acceptanceCriteria.length > 0) {
      const criteria = t.acceptanceCriteria
        .map((c) => `- [${c.done ? 'x' : ' '}] ${c.description}`)
        .join('\n');
      body.push('', '**Acceptance criteria:**', '', criteria);
    }
    const blockers = [
      ...t.blockedByDecisions.map((d) => `D-${d.seq}`),
      ...t.blockedByTasks.map((tt) => `T-${tt.seq}`),
    ];
    if (blockers.length > 0) body.push('', `**Blocked by:** ${blockers.join(', ')}`);
    if (t.sectionRef) body.push('', `**Section ref:** ${t.sectionRef}`);
    if (commentMap) {
      const block = renderCommentBlock(commentMap[t.id]);
      if (block) body.push('', block);
    }
    return body.join('\n');
  });
  return ['## Tasks', '', ...blocks].join('\n\n');
}

function renderAllComments(
  sections: DocSection[],
  decisions: Decision[],
  tasks: Task[],
  maps: CommentMaps,
  opts: { includeSectionComments: boolean; includeDecisionComments: boolean; includeTaskComments: boolean },
): string {
  const groups: string[] = [];

  if (opts.includeSectionComments) {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const block = renderCommentBlock(maps.bySection[s.id]);
      if (block) groups.push(`### On §${i + 1} ${s.title ?? toTitleCase(s.sectionType)}\n\n${block}`);
    }
  }

  if (opts.includeDecisionComments) {
    for (const d of decisions) {
      const block = renderCommentBlock(maps.byDecision[d.id]);
      if (block) groups.push(`### On D-${d.seq}: ${d.title}\n\n${block}`);
    }
  }

  if (opts.includeTaskComments) {
    for (const t of tasks) {
      const block = renderCommentBlock(maps.byTask[t.id]);
      if (block) groups.push(`### On T-${t.seq}: ${t.title}\n\n${block}`);
    }
  }

  if (groups.length === 0) return '';
  return ['## Comments', '', ...groups].join('\n\n');
}

function renderCommentBlock(comments: Comment[] | undefined): string {
  if (!comments || comments.length === 0) return '';
  return comments
    .map((c) => {
      const date = c.createdAt.slice(0, 10);
      const tag = c.resolvedAt ? ' [resolved]' : '';
      const resolution = c.resolution ? `\n  > Resolution: ${c.resolution}` : '';
      return `- **${c.authorName}** (${date})${tag}: ${c.content}${resolution}`;
    })
    .join('\n');
}

function toTitleCase(s: string): string {
  return s.replace(/(^|[_\s-])(\w)/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase());
}

export function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
