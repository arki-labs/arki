/** A run of letters, numbers, and marks. */
const WORD_RUN = /[\p{L}\p{N}\p{M}]+/uy;
/** An apostrophe or hyphen followed by another run: `don't`, `re-enter`. */
const JOINED_RUN = /['’-][\p{L}\p{N}\p{M}]+/uy;
/** A decimal separator between digits: `3.14`, `1,000`. The lookbehind needs the word so far to end in a number. */
const DECIMAL_PART = /(?<=\p{N})[.,]\p{N}+/uy;

/**
 * The one definition of a prose word, shared by `segment`, `keywords`, and every count or score
 * built on them: runs of letters, numbers, and marks, allowing internal apostrophes and hyphens
 * and decimal separators between digits. `don't`, `re-enter`, and `3.14` are each one word.
 *
 * It scans with sticky patterns instead of one pattern with a repeating group, because that group
 * overflowed the regex engine's stack on Node for megabytes of `a-a-a-`. Each step is linear.
 */
export function* wordBounds(text: string): Generator<readonly [start: number, end: number], void, undefined> {
  let position = 0;
  while (position < text.length) {
    WORD_RUN.lastIndex = position;
    const first = WORD_RUN.exec(text);
    if (first === null) {
      position += 1;
      continue;
    }
    const start = first.index;
    let end = start + first[0].length;
    for (;;) {
      JOINED_RUN.lastIndex = end;
      let joined = JOINED_RUN.exec(text);
      if (joined === null) {
        DECIMAL_PART.lastIndex = end;
        joined = DECIMAL_PART.exec(text);
      }
      if (joined === null) break;
      end += joined[0].length;
    }
    yield [start, end];
    position = end;
  }
}

export type WordSpan = Readonly<{ word: string; start: number; end: number }>;

/** Every word with its UTF-16 offsets, in order. */
export function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  for (const [start, end] of wordBounds(text)) spans.push({ word: text.slice(start, end), start, end });
  return spans;
}
