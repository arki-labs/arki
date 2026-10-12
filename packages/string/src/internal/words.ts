/**
 * The one definition of a prose word, shared by `segment`, `keywords`, and every count or score
 * built on them: runs of letters, numbers, and marks, allowing internal apostrophes and hyphens
 * and decimal separators between digits. `don't`, `re-enter`, and `3.14` are each one word.
 */
export const WORD = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+|(?<=\p{N})[.,]\p{N}+)*/gu;

export type WordSpan = Readonly<{ word: string; start: number; end: number }>;

/** Every word with its UTF-16 offsets, in order. */
export function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  for (const match of text.matchAll(WORD)) {
    spans.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return spans;
}
