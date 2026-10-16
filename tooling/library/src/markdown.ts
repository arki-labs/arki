/**
 * A small Markdown line scanner shared by `docs.ts` and `doc-examples.ts`.
 * It reads only what the doc rules need: fenced code blocks (CommonMark fence
 * rules), ATX headings and the prose between them. No full Markdown parser.
 */

/** One fenced code block. */
export type Fence = {
  /** 1-based line of the opening fence. */
  readonly line: number;
  /** The info string after the fence characters, trimmed (`ts run`, `sh`, ...). */
  readonly info: string;
  /** Body lines, with the opening fence's indent removed. */
  readonly body: readonly string[];
  /** False when the file ends before the closing fence. */
  readonly closed: boolean;
};

/** A line outside every fence, with its 1-based number. */
export type ProseLine = { readonly text: string; readonly line: number };

/**
 * An opening fence: 3+ backticks or tildes. Any run of leading spaces is
 * accepted, so blocks nested in list items are found too; the indent is
 * stripped from the body.
 */
const OPEN_FENCE = /^( *)(`+|~+)/;
const CLOSE_FENCE = /^ *(`{3,}|~{3,}) *$/;

/** Splits on LF or CRLF. */
export function splitLines(markdown: string): string[] {
  return markdown.split(/\r?\n/);
}

/**
 * Splits a file into fenced blocks and prose lines. A fence inside a longer
 * outer fence is body text, so Markdown shown inside Markdown is never a block.
 */
export function scanFences(markdown: string): { fences: Fence[]; prose: ProseLine[] } {
  const fences: Fence[] = [];
  const prose: ProseLine[] = [];
  const all = splitLines(markdown);
  let open: { line: number; indent: number; marker: string; info: string; body: string[] } | undefined;
  for (const [index, text] of all.entries()) {
    const line = index + 1;
    if (open) {
      // It closes on the same character, at least as long as the opening run.
      const close = CLOSE_FENCE.exec(text)?.[1];
      if (close !== undefined && close[0] === open.marker[0] && close.length >= open.marker.length) {
        fences.push({ line: open.line, info: open.info, body: open.body, closed: true });
        open = undefined;
        continue;
      }
      open.body.push(stripIndent(text, open.indent));
      continue;
    }
    const start = OPEN_FENCE.exec(text);
    const indent = start?.[1] ?? '';
    const marker = start?.[2] ?? '';
    const info = text.slice(indent.length + marker.length).trim();
    // CommonMark: a backtick fence's info string may not contain a backtick (that is inline code).
    if (marker.length >= 3 && !(marker.startsWith('`') && info.includes('`'))) {
      open = { line, indent: indent.length, marker, info, body: [] };
      continue;
    }
    prose.push({ text, line });
  }
  if (open) fences.push({ line: open.line, info: open.info, body: open.body, closed: false });
  return { fences, prose };
}

function stripIndent(text: string, indent: number): string {
  let cut = 0;
  while (cut < indent && text[cut] === ' ') cut += 1;
  return text.slice(cut);
}

/** An ATX heading (`## Title`) found outside fences. */
export type Heading = { readonly level: number; readonly text: string; readonly line: number };

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t](.*)$/;
/** An optional closing run of `#` (`## Title ##`). */
const CLOSING_HASHES = /[ \t]#+[ \t]*$/;

export function headings(markdown: string): Heading[] {
  return scanFences(markdown).prose.flatMap(({ text, line }) => {
    const match = ATX_HEADING.exec(text);
    const hashes = match?.[1];
    const title = match?.[2];
    if (hashes === undefined || title === undefined) return [];
    return [{ level: hashes.length, text: title.replace(CLOSING_HASHES, '').trim(), line }];
  });
}

/**
 * The file cut at its H2 headings: H2 text to the raw lines under it, fences
 * included, up to the next H2. Lines before the first H2 are not returned.
 */
export function h2Sections(markdown: string): Map<string, string[]> {
  const all = splitLines(markdown);
  const starts = headings(markdown).filter(heading => heading.level === 2);
  const sections = new Map<string, string[]>();
  for (const [index, heading] of starts.entries()) {
    const end = starts[index + 1]?.line ?? all.length + 1;
    if (!sections.has(heading.text)) sections.set(heading.text, all.slice(heading.line, end - 1));
  }
  return sections;
}
