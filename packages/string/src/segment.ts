/**
 * Splitting prose into lines, words, sentences, and paragraphs. Regular expressions only, so
 * results are identical in every runtime and never depend on the machine locale.
 */

const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/u;
/** Letter/number/mark runs, allowing internal apostrophes and hyphens, and decimal separators between digits. */
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+|(?<=\p{N})[.,]\p{N}+)*/gu;
/** A run of terminal punctuation, optional closing quotes/brackets, then whitespace or the end. */
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?:\s+|$)/gu;
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** Splits on CRLF, LF, CR, NEL, LS, and PS. `lines('')` is `['']`; trailing empty lines are kept. */
export function lines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/**
 * Prose words: runs of letters, numbers, and marks. `don't`, `re-enter`, and
 * `3.14` are each one word. Scripts without word spacing yield one word per run.
 */
export function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/** Number of prose words, using exactly `words()`. */
export function wordCount(text: string): number {
  return words(text).length;
}

/**
 * Sentences: text up to and including `.`, `!`, `?`, or `…` followed by whitespace or the end.
 * A trailing fragment without terminal punctuation is a sentence if it contains a letter or digit.
 * Abbreviations such as `Mr.` are not special-cased; `3.14` stays together.
 */
export function sentences(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    pushSentence(result, text.slice(start, end));
    start = end;
  }
  pushSentence(result, text.slice(start));
  return result;
}

function pushSentence(target: string[], candidate: string): void {
  const sentence = candidate.trim();
  if (HAS_WORD_CHARACTER.test(sentence)) target.push(sentence);
}

/** Number of sentences, using exactly `sentences()`. */
export function sentenceCount(text: string): number {
  return sentences(text).length;
}

/**
 * Paragraphs: non-blank lines, trimmed. Blank-line-separated and single-newline-separated text give
 * the same result unless a paragraph is hard-wrapped, which is rare in web inputs.
 */
export function paragraphs(text: string): string[] {
  return lines(text)
    .map(line => line.trim())
    .filter(line => line !== '');
}

/** Number of paragraphs, using exactly `paragraphs()`. */
export function paragraphCount(text: string): number {
  return paragraphs(text).length;
}
