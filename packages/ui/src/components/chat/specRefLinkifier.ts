/**
 * rehypeSpecRefLinkifier — a rehype plugin that auto-links a BARE `spec-N`
 * handle inside markdown text nodes.
 *
 * The third member of the linkifier family, and orthogonal to both siblings:
 *   - `rehypeRefLinkifier`     matches FULL canonical paths (`ns/mx/specs/spec-N/...`)
 *   - `rehypePerRefLinkifier`  matches the `[per dec-N]` cross-entity shorthand
 *   - this plugin              matches the bare `spec-N` a body writes in prose
 *
 * A bare handle resolves WITHIN THE CONTAINING MEMEX and nowhere else. Handles
 * are per-memex [per std-10 cl-14], which is exactly what makes the bare form
 * safe here and meaningless once the text is read from somewhere else; a
 * cross-memex reference therefore keeps the full canonical path its sibling
 * already matches.
 *
 * MOUNT ORDER MATTERS: this plugin must run AFTER `rehypeRefLinkifier`, so a
 * canonical path is already an anchor by the time this walker arrives and is
 * skipped wholesale. The pattern's own boundary guards make it correct either
 * way, but the order keeps the two from ever competing for the same text.
 *
 * The anchor carries `data-spec-ref` + `data-spec-handle` so a react-markdown
 * `a` component mapping can upgrade it into the interactive `<SpecRefPill>`,
 * which resolves the handle against the page's shared status set. No route is
 * knowable at plugin time (the plugin has no namespace/memex context), which is
 * why the href is inert here and the component owns it.
 *
 * Rules (mirrors both siblings):
 *   - Text inside `<code>` / `<pre>` is skipped — a handle in a code sample
 *     renders verbatim, and backticks stay the author's escape hatch
 *     [per std-10 cl-72].
 *   - Text inside an existing `<a>` is skipped, so nothing double-links
 *     [per std-10 cl-73].
 *   - Surrounding text is preserved exactly; only the matched substring moves.
 *   - Pure / render-time only. Storage stays plain markdown [per std-10 cl-74].
 */

// Local hast type shims — see refLinkifier.ts for why these are kept local
// rather than pulling in `@types/hast`.

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

// A bare `spec-N` handle, and ONLY that.
//
// - `spec-` is case-strict and the type prefix is mandatory [per std-10 cl-12,
//   cl-44], so `Spec-3` / `SPEC-3` are prose, not references.
// - `[1-9]\d*` — a positive integer with no leading zeros [per std-10 cl-11],
//   so `spec-0` and `spec-007` are not handles.
// - The lookbehind rejects a handle that is part of a longer token (`sub-spec-3`)
//   or a path segment (`.../specs/spec-3`, which belongs to rehypeRefLinkifier).
// - The lookahead rejects a trailing word or hyphen character (`spec-3a`), while
//   still allowing ordinary punctuation to abut (`spec-3.`, `spec-3,`).
// - `std-N` and `doc-N` are deliberately NOT matched (spec-529 dec-4): they carry
//   an approval state and open drift findings rather than a phase and tasks, so
//   they need their own card face, not a wider pattern here.
//
// `g` because we scan each text node for every handle it contains.
export const SPEC_HANDLE_PATTERN = /(?<![\w/-])spec-([1-9]\d*)(?![\w-])/g;

const SKIP_TAGS = new Set(['code', 'pre', 'a']);

/**
 * Builds the hast anchor a component mapping upgrades into the pill. Rendered
 * without that mapping it is an inert anchor showing the handle exactly as the
 * author wrote it — the same degradation an unresolvable handle gets.
 */
function makeSpecAnchor(handle: string): HastElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      // The route depends on the containing namespace/memex, which the plugin
      // cannot see; SpecRefPill builds the real href.
      href: '#',
      className: ['spec-ref-link'],
      'data-spec-ref': 'true',
      'data-spec-handle': handle,
    },
    children: [{ type: 'text', value: handle }],
  };
}

/**
 * Splits one text node into text + anchor nodes. Returns the original node
 * (wrapped) when nothing matches, so untouched subtrees keep their identity.
 */
function linkifyTextNode(node: HastText): HastChild[] {
  const value = node.value;
  SPEC_HANDLE_PATTERN.lastIndex = 0;

  const out: HastChild[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = SPEC_HANDLE_PATTERN.exec(value)) !== null) {
    const [full] = match;
    const start = match.index;

    if (start > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, start) });
    }
    out.push(makeSpecAnchor(full));
    cursor = start + full.length;

    // Cheap insurance against a zero-width match spinning forever.
    if (match.index === SPEC_HANDLE_PATTERN.lastIndex) {
      SPEC_HANDLE_PATTERN.lastIndex++;
    }
  }

  if (out.length === 0) return [node];
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}

/**
 * Walks the tree, transforming text children of any element that isn't itself
 * a `code` / `pre` / `a` (those subtrees are skipped whole).
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
 * rehype plugin factory. Pass to `rehypePlugins` on `<ReactMarkdown>`, AFTER
 * `rehypeRefLinkifier`.
 */
export function rehypeSpecRefLinkifier() {
  return (tree: HastRoot) => {
    walk(tree);
  };
}

export default rehypeSpecRefLinkifier;
