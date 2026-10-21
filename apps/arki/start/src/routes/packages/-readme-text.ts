/**
 * Pure helpers that read compiled README HTML. The package index shows one line of purpose per package, and that
 * line must come from the package's own README, never from text we write.
 */

const paragraphPattern = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g;
const tagPattern = /<[^>]*>/g;
const namedEntities: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return namedEntities[code.toLowerCase()] ?? match;
  });
}

/** Plain text of an HTML fragment, whitespace collapsed. */
function plainText(html: string): string {
  return decodeEntities(html.replaceAll(tagPattern, '')).replaceAll(/\s+/g, ' ').trim();
}

/**
 * The first sentence of the first paragraph that has text, or null when the README has none. Paragraphs that hold
 * only images (badges) have no text and are skipped.
 */
export function readmePurpose(html: string): string | null {
  for (const match of html.matchAll(paragraphPattern)) {
    const text = plainText(match[1] ?? '');
    if (text === '') continue;
    const sentence = /^(.*?[.!?])(?=\s|$)/.exec(text);
    return sentence?.[1] ?? text;
  }
  return null;
}

/** The README without its leading `<h1>`: the package page already shows the package name as its H1. */
export function withoutLeadingTitle(html: string): string {
  return html.replace(/^\s*<h1(?:\s[^>]*)?>[\s\S]*?<\/h1>\s*/, '');
}
