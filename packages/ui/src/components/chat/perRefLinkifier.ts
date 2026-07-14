/**
 * rehypePerRefLinkifier — a rehype plugin that auto-links the `[per dec-N]` /
 * `[per t-N]` cross-entity SHORTHAND inside markdown text nodes.
 *
 * This is the companion to `rehypeRefLinkifier` (spec-484 dec-2). The two are
 * ORTHOGONAL: `rehypeRefLinkifier` matches FULL canonical paths
 * (`ns/mx/specs/spec-N/...`); this plugin matches the `[per dec-N]` /
 * `[per t-N]` shorthand that `parseEntityRefs` (DecisionLink.tsx) used to
 * handle before comment bodies moved onto the markdown render path. Running
 * both plugins keeps every ref syntax linkified while comment bodies compose
 * as real markdown.
 *
 * The anchor this plugin emits carries `data-per-ref` (`dec` | `task`) +
 * `data-per-handle` (the bare handle) so a react-markdown `a` component mapping
 * can upgrade it into an interactive `<DecisionLink>` / `<TaskLink>` — those
 * components resolve the handle server-side on click and navigate to the parent
 * Spec (the route a plain static anchor cannot know at render time). A plain
 * anchor is emitted when no component mapping intercepts it, so the plugin is
 * still meaningful on its own (and directly unit-testable).
 *
 * Rules (mirrors refLinkifier):
 *   - Text inside `<code>` (inline) or `<pre>` (fenced) is skipped — shorthand
 *     embedded in code samples renders verbatim.
 *   - Text inside an existing `<a>` is skipped to avoid double-linking.
 *   - Surrounding text is preserved exactly; only the matched `[per …]`
 *     substring is wrapped in an anchor.
 *   - Pure / render-time only: no Date.now / Math.random. Storage stays plain.
 */

// Local hast type shims — narrow versions of the @types/hast definitions,
// matching what `react-markdown` hands to rehype plugins (see refLinkifier.ts
// for the rationale on keeping these local).

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

// `[per <handle>]` where <handle> is one of the three cite forms parseEntityRefs
// accepts — Spec-qualified (`mis-N:dec-M`, t-7), doc-qualified (`doc-N:dec-M`,
// legacy), or bare (`dec-M`) — plus bare task handles (`t-N`). Kept structurally
// identical to `PER_REF_REGEX` in DecisionLink.tsx so the two never drift. `g`
// because we scan each text node for every shorthand it contains.
export const PER_REF_PATTERN =
  /\[per ((?:(?:mis|doc)-\d+:)?dec-\d+|t-\d+)\]/g;

const SKIP_TAGS = new Set(['code', 'pre', 'a']);

/**
 * The entity channel a handle routes to — `t-N` → task, everything else → dec.
 * Mirrors the `kind` derivation in `parseEntityRefs`.
 */
function perRefKind(handle: string): 'dec' | 'task' {
  return handle.startsWith('t-') ? 'task' : 'dec';
}

/**
 * Builds a hast anchor carrying the shorthand handle + kind. A react-markdown
 * `a` component mapping reads `data-per-ref` / `data-per-handle` to render the
 * interactive DecisionLink / TaskLink; unmapped it renders as a plain anchor.
 * The visible label is the bare handle (matching DecisionLink's own label),
 * not the `[per …]` wrapper.
 */
function makePerAnchor(handle: string): HastElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      // No static route is knowable at render time (DecisionLink/TaskLink
      // resolve the handle on click); the component mapping intercepts this.
      href: '#',
      className: ['per-ref-link'],
      'data-per-ref': perRefKind(handle),
      'data-per-handle': handle,
    },
    children: [{ type: 'text', value: handle }],
  };
}

/**
 * Splits a single text node into text + anchor nodes by scanning for `[per …]`
 * shorthand. Returns the original node (wrapped) when nothing matches so callers
 * can leave the reference unchanged.
 */
function linkifyTextNode(node: HastText): HastChild[] {
  const value = node.value;
  PER_REF_PATTERN.lastIndex = 0;

  const out: HastChild[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = PER_REF_PATTERN.exec(value)) !== null) {
    const [full, handle] = match;
    const start = match.index;
    const end = start + full.length;

    if (start > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, start) });
    }
    out.push(makePerAnchor(handle));
    cursor = end;

    if (match.index === PER_REF_PATTERN.lastIndex) {
      PER_REF_PATTERN.lastIndex++;
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
 * that isn't itself `code` / `pre` / `a` (those subtrees are skipped wholesale).
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
 * rehype plugin factory. Pass to `rehypePlugins` on `<ReactMarkdown>` alongside
 * `rehypeRefLinkifier`.
 */
export function rehypePerRefLinkifier() {
  return (tree: HastRoot) => {
    walk(tree);
  };
}

export default rehypePerRefLinkifier;
