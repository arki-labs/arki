/**
 * Code copied from real files, as the marketing pages show it. Every excerpt names its file and its first line, and
 * `e2e/home.spec.ts` opens each file and checks that every line is exactly where the data says it is.
 */

/** A run of consecutive lines copied from one file. */
export type ExcerptPart = {
  /** Names the part, so a stepper can light it. */
  id: string;
  /** The file, relative to the workspace root. */
  path: string;
  /** The line number, in that file, of the first line. */
  from: number;
  /** Import lines from the top of the file. No blank line is drawn between two import parts. */
  imports?: true;
  lines: readonly string[];
};

/** Parts shown one after another. A gap between parts of one file is drawn as a blank line. */
export type Excerpt = {
  /** What the reader should notice, added to the caption. */
  note?: string;
  parts: readonly ExcerptPart[];
};

/** Whether a blank line is drawn before `part`: it is, when lines between it and the part before are left out. */
export function gapBefore(before: ExcerptPart | undefined, part: ExcerptPart): boolean {
  if (before === undefined) return false;
  if (before.imports === true && part.imports === true) return false;
  return before.path !== part.path || before.from + before.lines.length !== part.from;
}

type LineRange = { from: number; to: number };
type CaptionGroup = { path: string; ranges: LineRange[] };

const range = ({ from, to }: LineRange) => (from === to ? `${from}` : `${from}–${to}`);

/** "path · lines 39–42", with one range per run of lines and one group per file. */
export function excerptCaption({ note, parts }: Excerpt): string {
  const groups: CaptionGroup[] = [];
  for (const part of parts) {
    const to = part.from + part.lines.length - 1;
    const group = groups.at(-1);
    if (group === undefined || group.path !== part.path) {
      groups.push({ path: part.path, ranges: [{ from: part.from, to }] });
      continue;
    }
    const last = group.ranges.at(-1);
    if (last !== undefined && last.to + 1 === part.from) last.to = to;
    else group.ranges.push({ from: part.from, to });
  }
  const files = groups.map(({ path, ranges }) => {
    const count = ranges.reduce((sum, { from, to }) => sum + (to - from + 1), 0);
    return `${path} · ${count === 1 ? 'line' : 'lines'} ${ranges.map(item => range(item)).join(', ')}`;
  });
  return [...files, ...(note === undefined ? [] : [note])].join(' · ');
}

/** A sentence quoted from one line of a file: `text` is part of that line, exactly as written there. */
export type SourceQuote = {
  path: string;
  line: number;
  text: string;
};
