import type { EmbeddingModel, EmbedInput } from './types.js';
import { InputTooLong } from './failures.js';
import { countTokens } from './tokens.js';

/** A run of consecutive inputs sent as one request: `inputs.slice(start, end)`. */
export type Chunk = { readonly start: number; readonly end: number };

/**
 * Splits inputs, in order, into chunks of at most `model.maxBatch` inputs and `model.maxBatchTokens`
 * tokens. An input that alone exceeds `maxBatchTokens` is refused before any request is made.
 */
export function pack(model: EmbeddingModel, inputs: readonly EmbedInput[]) {
  const chunks: Chunk[] = [];
  let start = 0;
  let tokens = 0;
  for (const [index, input] of inputs.entries()) {
    const counted = countTokens(model, input);
    const cost = counted.basis === 'unknown' ? 0 : counted.count;
    if (cost > model.maxBatchTokens) return InputTooLong({ index, tokens: counted, max: model.maxBatchTokens });
    if (index > start && (index - start >= model.maxBatch || tokens + cost > model.maxBatchTokens)) {
      chunks.push({ start, end: index });
      start = index;
      tokens = 0;
    }
    tokens += cost;
  }
  if (inputs.length > start) chunks.push({ start, end: inputs.length });
  return chunks;
}
