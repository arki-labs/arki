import type { EmbeddingModel, EmbedInput, TokenCount } from './types.js';

/** The text part of an input; `''` for an image-only input. */
export function textOf(input: EmbedInput): string {
  return typeof input === 'string' ? input : (input.text ?? '');
}

/**
 * Tokens one input costs. Slice 0 estimates `ceil(chars / 4)` for every model; a tokenizer
 * (`counted`) arrives in slice 1. The model parameter is that seam.
 */
export function countTokens(_model: EmbeddingModel, input: EmbedInput): TokenCount {
  return { basis: 'estimated', count: Math.ceil(textOf(input).length / 4) };
}

const BASIS_STRENGTH = { reported: 3, counted: 2, estimated: 1, unknown: 0 } as const;

/** Sums counts; the basis is the weakest seen (`reported` > `counted` > `estimated`; any `unknown` → `unknown`). */
export function addTokens(a: TokenCount, b: TokenCount): TokenCount {
  if (a.basis === 'unknown' || b.basis === 'unknown') return { basis: 'unknown' };
  const basis = BASIS_STRENGTH[a.basis] <= BASIS_STRENGTH[b.basis] ? a.basis : b.basis;
  return { basis, count: a.count + b.count };
}
