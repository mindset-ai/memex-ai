import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';
import { extractBlocks, computeDiffRanges, registerDiffHighlights, clearDiffHighlights } from './diffHighlight';

// spec-448 ac-32: changed paragraphs get a block-level highlight and changed
// words a word-level highlight; added vs removed use distinct, theme-aware
// colours.
const AC_DISTINCT_COLOURS = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-32';

// spec-448 ac-7: within a changed section the diff highlights changed
// paragraphs at block level and the specific changed words within them
// (Claude Code-style), painted over the normal rendered markdown without
// replacing the renderer.
const AC_BLOCK_WORD = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-7';
// spec-448 ac-30: the diff input is the rendered block text (DOM text
// nodes), not the raw markdown source string.
const AC_RENDERED_TEXT = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-30';
// spec-448 ac-31: changed words are painted via the CSS Custom Highlight API
// over the existing react-markdown render, without mutating the markdown
// DOM tree.
const AC_CUSTOM_HIGHLIGHT = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-31';

function mount(oldHtml: string, newHtml: string): { oldEl: Element; newEl: Element } {
  document.body.innerHTML = `<div id="old">${oldHtml}</div><div id="new">${newHtml}</div>`;
  return {
    oldEl: document.getElementById('old')!,
    newEl: document.getElementById('new')!,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  clearDiffHighlights();
});

describe('extractBlocks', () => {
  it('reads TEXT FROM THE RENDERED DOM, not markdown source (ac-30)', () => {
    tagAc(AC_RENDERED_TEXT);
    // The raw markdown source for this would be "**bold** word" — but the
    // renderer has already turned it into a <strong> element. extractBlocks
    // must walk the rendered text nodes and see the flattened "bold word",
    // proving the diff input is the DOM, not the markdown string.
    document.body.innerHTML = '<p><strong>bold</strong> word</p>';
    const [block] = extractBlocks(document.body);
    expect(block.text).toBe('bold word');
  });

  it('skips spec-100 comment-marker sentinel text so markers do not pollute the diff', () => {
    tagAc(AC_RENDERED_TEXT);
    document.body.innerHTML =
      '<p>hello <span data-marker-seq="1">📍c-1</span> world</p>';
    const [block] = extractBlocks(document.body);
    expect(block.text).toBe('hello  world');
  });

  it('counts each top-level block once, ignoring nested block elements', () => {
    document.body.innerHTML = '<div><p>one</p><ul><li>two</li></ul></div>';
    const blocks = extractBlocks(document.body);
    expect(blocks.map((b) => b.text)).toEqual(['one', 'two']);
  });
});

describe('computeDiffRanges (block-then-word, ac-7)', () => {
  it('finds no ranges when the rendered text is identical', () => {
    const { oldEl, newEl } = mount('<p>unchanged text</p>', '<p>unchanged text</p>');
    const ranges = computeDiffRanges(oldEl, newEl);
    expect(ranges.oldBlockRanges).toHaveLength(0);
    expect(ranges.newBlockRanges).toHaveLength(0);
    expect(ranges.delRanges).toHaveLength(0);
    expect(ranges.addRanges).toHaveLength(0);
  });

  it('a changed paragraph gets a block range on both sides AND word-level del/add ranges', () => {
    tagAc(AC_BLOCK_WORD);
    const { oldEl, newEl } = mount('<p>the quick brown fox</p>', '<p>the quick red fox</p>');
    const ranges = computeDiffRanges(oldEl, newEl);
    // Block-level: exactly one changed paragraph on each side.
    expect(ranges.oldBlockRanges).toHaveLength(1);
    expect(ranges.newBlockRanges).toHaveLength(1);
    expect(ranges.oldBlockRanges[0].toString()).toBe('the quick brown fox');
    expect(ranges.newBlockRanges[0].toString()).toBe('the quick red fox');
    // Word-level: only the changed word is captured on each side.
    const delText = ranges.delRanges.map((r) => r.toString()).join('');
    const addText = ranges.addRanges.map((r) => r.toString()).join('');
    expect(delText).toContain('brown');
    expect(addText).toContain('red');
    expect(delText).not.toContain('quick');
    expect(addText).not.toContain('quick');
  });

  it('a whole added paragraph (no old counterpart) is captured as a pure addition', () => {
    const { oldEl, newEl } = mount('<p>first</p>', '<p>first</p><p>second</p>');
    const ranges = computeDiffRanges(oldEl, newEl);
    expect(ranges.oldBlockRanges).toHaveLength(0);
    expect(ranges.newBlockRanges).toHaveLength(1);
    expect(ranges.newBlockRanges[0].toString()).toBe('second');
    expect(ranges.addRanges.map((r) => r.toString())).toEqual(['second']);
    expect(ranges.delRanges).toHaveLength(0);
  });

  it('a whole removed paragraph (no new counterpart) is captured as a pure removal', () => {
    const { oldEl, newEl } = mount('<p>first</p><p>second</p>', '<p>first</p>');
    const ranges = computeDiffRanges(oldEl, newEl);
    expect(ranges.newBlockRanges).toHaveLength(0);
    expect(ranges.oldBlockRanges).toHaveLength(1);
    expect(ranges.oldBlockRanges[0].toString()).toBe('second');
    expect(ranges.delRanges.map((r) => r.toString())).toEqual(['second']);
    expect(ranges.addRanges).toHaveLength(0);
  });

  it('handles two empty containers without throwing', () => {
    const { oldEl, newEl } = mount('', '');
    expect(() => computeDiffRanges(oldEl, newEl)).not.toThrow();
  });

  it('a mismatched removed/added run (1 paragraph replaced by 2) pairs the first and treats the surplus as a pure addition', () => {
    tagAc(AC_BLOCK_WORD);
    const { oldEl, newEl } = mount(
      '<p>the quick brown fox</p>',
      '<p>the quick red fox</p><p>a brand new paragraph</p>',
    );
    const ranges = computeDiffRanges(oldEl, newEl);
    // Old side only ever had one block — it's paired (changed), not removed.
    expect(ranges.oldBlockRanges).toHaveLength(1);
    expect(ranges.delRanges.map((r) => r.toString())).toEqual(['brown']);
    // New side has the paired block PLUS the surplus pure addition.
    expect(ranges.newBlockRanges.map((r) => r.toString()).sort()).toEqual(
      ['a brand new paragraph', 'the quick red fox'].sort(),
    );
    expect(ranges.addRanges.map((r) => r.toString())).toContain('a brand new paragraph');
    expect(ranges.addRanges.map((r) => r.toString())).toContain('red');
  });

  it('a mismatched removed/added run (2 paragraphs replaced by 1) pairs the first and treats the surplus as a pure removal', () => {
    tagAc(AC_BLOCK_WORD);
    const { oldEl, newEl } = mount(
      '<p>the quick brown fox</p><p>a paragraph going away</p>',
      '<p>the quick red fox</p>',
    );
    const ranges = computeDiffRanges(oldEl, newEl);
    expect(ranges.newBlockRanges).toHaveLength(1);
    expect(ranges.addRanges.map((r) => r.toString())).toEqual(['red']);
    expect(ranges.oldBlockRanges.map((r) => r.toString()).sort()).toEqual(
      ['a paragraph going away', 'the quick brown fox'].sort(),
    );
    expect(ranges.delRanges.map((r) => r.toString())).toContain('a paragraph going away');
    expect(ranges.delRanges.map((r) => r.toString())).toContain('brown');
  });
});

describe('registerDiffHighlights / clearDiffHighlights (ac-31)', () => {
  it('registers ranges via CSS.highlights (the Custom Highlight API), never mutating the DOM tree', () => {
    tagAc(AC_CUSTOM_HIGHLIGHT);
    const { oldEl, newEl } = mount('<p>the quick brown fox</p>', '<p>the quick red fox</p>');
    const oldHtmlBefore = oldEl.innerHTML;
    const newHtmlBefore = newEl.innerHTML;
    const ranges = computeDiffRanges(oldEl, newEl);
    registerDiffHighlights(ranges);

    // No DOM mutation: the rendered markdown tree is byte-for-byte unchanged.
    expect(oldEl.innerHTML).toBe(oldHtmlBefore);
    expect(newEl.innerHTML).toBe(newHtmlBefore);

    // The CSS Custom Highlight API registry now carries the three named
    // highlights this feature paints (block / del / add).
    const cssAny = CSS as unknown as { highlights?: Map<string, unknown> };
    expect(cssAny.highlights?.has('diff-block')).toBe(true);
    expect(cssAny.highlights?.has('diff-del')).toBe(true);
    expect(cssAny.highlights?.has('diff-add')).toBe(true);

    clearDiffHighlights();
    expect(cssAny.highlights?.has('diff-block')).toBe(false);
    expect(cssAny.highlights?.has('diff-del')).toBe(false);
    expect(cssAny.highlights?.has('diff-add')).toBe(false);
  });

  it('is a no-op (does not throw) when the Custom Highlight API is unavailable', () => {
    const cssAny = CSS as unknown as { highlights?: Map<string, unknown> };
    const original = cssAny.highlights;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (cssAny as any).highlights;
    expect(() => registerDiffHighlights({ oldBlockRanges: [], newBlockRanges: [], delRanges: [], addRanges: [] })).not.toThrow();
    cssAny.highlights = original;
  });
});

describe('index.css diff highlight rules (ac-32)', () => {
  const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../index.css');
  const css = readFileSync(CSS_PATH, 'utf-8');

  // Extract every `background-color` declared for a given ::highlight() rule,
  // across both the `.dark` and `.light` theme blocks, by pulling each rule
  // body and reading its background-color value.
  function backgroundColorsFor(highlightName: string): string[] {
    const re = new RegExp(`::highlight\\(${highlightName}\\)\\s*\\{([^}]*)\\}`, 'g');
    const colors: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(css))) {
      const bg = /background-color:\s*([^;]+);/.exec(match[1]);
      if (bg) colors.push(bg[1].trim());
    }
    return colors;
  }

  it('declares a block-level, an add, and a del highlight rule', () => {
    tagAc(AC_DISTINCT_COLOURS);
    expect(css).toMatch(/::highlight\(diff-block\)/);
    expect(css).toMatch(/::highlight\(diff-add\)/);
    expect(css).toMatch(/::highlight\(diff-del\)/);
  });

  it('gives each theme (dark/light) an explicit colour for diff-add and diff-del', () => {
    tagAc(AC_DISTINCT_COLOURS);
    const addColors = backgroundColorsFor('diff-add');
    const delColors = backgroundColorsFor('diff-del');
    // One declaration per theme (dark + light).
    expect(addColors).toHaveLength(2);
    expect(delColors).toHaveLength(2);
  });

  it('uses DISTINCT colours for added vs removed in every theme (not the same hue reused)', () => {
    tagAc(AC_DISTINCT_COLOURS);
    const addColors = backgroundColorsFor('diff-add');
    const delColors = backgroundColorsFor('diff-del');
    for (let i = 0; i < addColors.length; i++) {
      expect(addColors[i]).not.toBe(delColors[i]);
    }
  });
});
