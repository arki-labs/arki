/**
 * Sentence end offsets, shared by `sentences()`, sentence-aligned truncation and excerpts.
 * A sentence ends at `.`, `!`, `?`, or `…` (a run of them), plus any closing quotes or brackets,
 * when whitespace or the end of the text follows. `3.14` and `e.g.x` stay together.
 */

const SENTENCE_PUNCTUATION = /[.!?…]+/gu;
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']']);
const WHITESPACE = /\s/u;

export type SentenceEnd = Readonly<{
  /** Offset just after the terminal punctuation and closers. */
  end: number;
  /** Offset of the next sentence: after the whitespace that follows `end`. */
  next: number;
}>;

/** Every sentence end in `text`, in order. Linear in the text length. */
export function sentenceEnds(text: string): SentenceEnd[] {
  const result: SentenceEnd[] = [];
  for (const match of text.matchAll(SENTENCE_PUNCTUATION)) {
    let end = match.index + match[0].length;
    while (end < text.length && CLOSERS.has(text.charAt(end))) end += 1;
    if (end < text.length && !WHITESPACE.test(text.charAt(end))) continue;
    let next = end;
    while (next < text.length && WHITESPACE.test(text.charAt(next))) next += 1;
    result.push({ end, next });
  }
  return result;
}
