/**
 * rehypeRefLinkifier — a rehype plugin that auto-links canonical Memex path
 * references inside markdown text nodes.
 *
 * Matches paths of the form `<ns>/<mx>/<doc-type>/<doc-handle>` optionally
 * followed by `/<child-type>/<child-handle>` and turns each match into an
 * `<a href="/...">...</a>` element. Storage stays plain markdown — this is a
 * pure render-time transform.
 *
 * Rules:
 *   - Text inside `<code>` (inline) or `<pre>` (fenced) is skipped — refs
 *     embedded in code samples should render verbatim.
 *   - Text inside an existing `<a>` is skipped to avoid double-linking.
 *   - Surrounding text is preserved exactly; only the matched substring is
 *     wrapped in an anchor.
 */
// Local hast type shims — narrow versions of the @types/hast definitions
// covering just the node variants this plugin touches. Keeping them local
// avoids adding `@types/hast` as a direct dependency (it isn't hoisted into
// the workspace's admin node_modules) and the structural shape matches
// what `react-markdown` hands to rehype plugins.

type HastText = { type: 'text'; value: string };

type HastProperties = Record<
  string,
  string | number | boolean | null | undefined | (string | number)[]
>;

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: HastProperties;
  children: HastChild[];
}

type HastChild = HastText | HastElement | { type: string; [key: string]: unknown };

interface HastRoot {
  type: 'root';
  children: HastChild[];
}

// <ns>/<mx>/<doc-type>/<doc-handle>(/<child-type>/<child-handle>)?
//
// - <ns>, <mx>: kebab-lowercase, must start with a letter.
// - <doc-type>: specs | docs | standards | execution-plans. Legacy `briefs`
//   still matches so old chat history / agent prose keeps linking — the
//   server-side 301 handles the redirect.
// - <doc-handle>: spec-N | b-N | doc-N | std-N.
// - <child-type>: sections | decisions | tasks | comments.
// - <child-handle>: s-N | dec-N | t-N | c-N.
//
// Use \b on both ends so refs that abut prose punctuation still match without
// swallowing trailing characters. The regex is `g` because we scan each text
// node for *all* refs it contains.
export const REF_PATTERN =
  /\b([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\/(specs|briefs|docs|standards|execution-plans)\/((?:spec|b|doc|std)-\d+)(?:\/(sections|decisions|tasks|comments)\/((?:s|dec|t|c)-\d+))?\b/g;

const SKIP_TAGS = new Set(['code', 'pre', 'a']);

/**
 * Builds a hast anchor element pointing to the canonical path.
 */
function makeAnchor(href: string, label: string): HastElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      href,
      // Add a hook so render surfaces / tests can identify auto-linked refs.
      className: ['ref-link'],
      'data-ref-link': 'true',
    },
    children: [{ type: 'text', value: label }],
  };
}

/**
 * Splits a single text node into an array of text + anchor nodes by scanning
 * for ref matches. Returns the original node (wrapped in an array) when no
 * matches occur, so callers can keep the existing reference unchanged.
 */
function linkifyTextNode(node: HastText): HastChild[] {
  const value = node.value;
  // Reset the global regex's lastIndex; we share one instance per module.
  REF_PATTERN.lastIndex = 0;

  const out: HastChild[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_PATTERN.exec(value)) !== null) {
    const [full] = match;
    const start = match.index;
    const end = start + full.length;

    if (start > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, start) });
    }
    // The href is the same as the matched text, prefixed with `/` so it stays
    // same-origin.
    out.push(makeAnchor(`/${full}`, full));
    cursor = end;

    // Guard against zero-width matches (shouldn't happen with the current
    // pattern, but cheap insurance against an infinite loop).
    if (match.index === REF_PATTERN.lastIndex) {
      REF_PATTERN.lastIndex++;
    }
  }

  if (out.length === 0) return [node];
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}

/**
 * Recursively walks the hast tree, transforming text children of any element
 * that isn't itself a `code` / `pre` / `a` (those subtrees are skipped wholesale).
 */
function walk(node: HastRoot | HastElement): void {
  if (!Array.isArray(node.children)) return;

  const nextChildren: HastChild[] = [];
  let mutated = false;

  for (const child of node.children) {
    if (child.type === 'text') {
      const textChild = child as HastText;
      const replacement = linkifyTextNode(textChild);
      if (replacement.length !== 1 || replacement[0] !== textChild) {
        mutated = true;
      }
      nextChildren.push(...replacement);
      continue;
    }

    if (child.type === 'element') {
      const elementChild = child as HastElement;
      if (SKIP_TAGS.has(elementChild.tagName)) {
        // Don't descend into code/pre/a — leave their subtree alone.
        nextChildren.push(elementChild);
        continue;
      }
      walk(elementChild);
      nextChildren.push(elementChild);
      continue;
    }

    nextChildren.push(child);
  }

  if (mutated) {
    node.children = nextChildren;
  }
}

/**
 * rehype plugin factory. Pass to `rehypePlugins` on `<ReactMarkdown>`.
 */
export function rehypeRefLinkifier() {
  return (tree: HastRoot) => {
    walk(tree);
  };
}

export default rehypeRefLinkifier;
