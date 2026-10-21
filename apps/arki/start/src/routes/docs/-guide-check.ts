const shellBlock = /<pre\s[^>]*?data-language="(?:sh|bash|shell)"[^>]*>([\s\S]*?)<\/pre>/g;
const htmlTag = /<[^>]*>/g;
const htmlEntity = /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi;

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntity(match: string, body: string): string {
  const lower = body.toLowerCase();
  if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
  if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
  return named[lower] ?? match;
}

/**
 * The command a guide ends with: the last non-comment line of the last shell code block in its compiled HTML.
 * Guides end with the step that checks the result, so this is what a reader runs to know they are done.
 * Null when the guide has no shell block.
 */
export function lastShellCommand(html: string): string | null {
  const blocks = [...html.matchAll(shellBlock)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return null;
  const lines = last
    .replaceAll(htmlTag, '')
    .replaceAll(htmlEntity, decodeEntity)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
  return lines.at(-1) ?? null;
}
