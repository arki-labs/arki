import type { EmbeddingModel, EmbedInput, TokenCount } from './types.js';
import { InputTooLong } from './failures.js';

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
 * Tokens one input costs. `counted` when the model record carries a tokenizer (`model.countTokens`),
 * otherwise `estimated` as `ceil(characters / 4)`. No adapter in this release ships a tokenizer, so
 * every count is an estimate; a provider's own count replaces it in `usage` when it reports one.
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
 * The `InputTooLong` for a provider's "context length exceeded" answer, which does not say which
 * input it was. Names the longest one by estimate: the likeliest culprit, with its estimated count.
 */
export function providerInputTooLong(texts: readonly string[], max: number) {
  let index = 0;
  for (const [position, text] of texts.entries()) if (text.length > (texts[index]?.length ?? 0)) index = position;
  return InputTooLong({ index, tokens: estimate(texts[index] ?? ''), max });
}

const BASIS_STRENGTH = { reported: 3, counted: 2, estimated: 1, unknown: 0 } as const;

/** Sums counts; the basis is the weakest seen (`reported` > `counted` > `estimated`; any `unknown` → `unknown`). */
export function addTokens(a: TokenCount, b: TokenCount): TokenCount {
  if (a.basis === 'unknown' || b.basis === 'unknown') return { basis: 'unknown' };
  const basis = BASIS_STRENGTH[a.basis] <= BASIS_STRENGTH[b.basis] ? a.basis : b.basis;
  return { basis, count: a.count + b.count };
}
