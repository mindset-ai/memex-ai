/**
 * Converts a subset of GitHub-flavoured Markdown to Slack mrkdwn.
 *
 * Supported patterns (dec-1, spec-71):
 *   **bold**        → *bold*
 *   *italic*        → _italic_
 *   `code`          → `code`   (unchanged)
 *   [text](url)     → <url|text>
 *   # Heading       → *Heading*
 *   - item          → - item   (unchanged)
 *
 * Unrecognised constructs (e.g. ~~strike~~) are stripped rather than leaked.
 */
export function markdownToMrkdwn(text: string): string {
  const saved: string[] = [];
  const save = (s: string): string => {
    saved.push(s);
    return `\x00S${saved.length - 1}\x00`;
  };

  let result = text
    // Protect inline code spans from all other conversions.
    .replace(/`([^`]+)`/g, (m) => save(m))
    // Headings: # Title → *Title*  (save so italic pass won't re-process)
    .replace(/^#{1,6}\s+(.+)$/gm, (_, t) => save(`*${t.trim()}*`))
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
    // Bold: **text** → *text*  (save so italic pass won't re-process)
    .replace(/\*\*([^*\n]+?)\*\*/g, (_, t) => save(`*${t}*`))
    // Italic single-asterisk: *text* → _text_  (runs after bold is saved)
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, "_$1_")
    // Strikethrough: ~~text~~ → text  (strip markers, unsupported in mrkdwn)
    .replace(/~~([^~\n]+)~~/g, "$1");

  return result.replace(/\x00S(\d+)\x00/g, (_, i) => saved[Number(i)]);
}
