import type { EmbeddingModel, EmbedInput, TokenCount } from './types.js';

/** The text part of an input; `''` for an image-only input. */
export function textOf(input: EmbedInput): string {
  return typeof input === 'string' ? input : (input.text ?? '');
}

/** Characters per token the estimate assumes; also where `onTooLong: 'truncate'` cuts without a tokenizer. */
export const CHARS_PER_TOKEN = 4;

/** `ceil(characters / 4)`: the estimate used when no tokenizer is at hand. */
function estimate(text: string): TokenCount {
  return { basis: 'estimated', count: Math.ceil(text.length / CHARS_PER_TOKEN) };
}

/**
 * Tokens one input costs. `counted` when the model record carries a tokenizer (`model.countTokens`,
 * as `./transformers` records do), otherwise `estimated` as `ceil(characters / 4)`; a provider's own
 * count replaces an estimate in `usage` when it reports one.
 *
 * @example
 * countTokens(model, 'twelve chars'); // { basis: 'estimated', count: 3 }
 */
export function countTokens(model: EmbeddingModel, input: EmbedInput): TokenCount {
  const text = textOf(input);
  if (model.countTokens === undefined) return estimate(text);
  return { basis: 'counted', count: model.countTokens(text) };
}

/**
 * `text` cut where `onTooLong: 'truncate'` cuts without a tokenizer: its first `maxTokens * 4` UTF-16
 * code units, less a high surrogate left last, so a character is never split in half.
 *
 * @example
 * truncateByEstimate('a'.repeat(7) + '😀', 2); // 'aaaaaaa': the emoji is dropped whole
 */
export function truncateByEstimate(text: string, maxTokens: number): string {
  const cut = text.slice(0, maxTokens * CHARS_PER_TOKEN);
  // A high surrogate last lost its low half to the cut. Checked by code unit, without the `u` flag:
  // `isWellFormed` is not on every runtime.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const BASIS_STRENGTH = { reported: 3, counted: 2, estimated: 1, unknown: 0 } as const;

/** Sums counts; the basis is the weakest seen (`reported` > `counted` > `estimated`; any `unknown` → `unknown`). */
export function addTokens(a: TokenCount, b: TokenCount): TokenCount {
  if (a.basis === 'unknown' || b.basis === 'unknown') return { basis: 'unknown' };
  const basis = BASIS_STRENGTH[a.basis] <= BASIS_STRENGTH[b.basis] ? a.basis : b.basis;
  return { basis, count: a.count + b.count };
}
