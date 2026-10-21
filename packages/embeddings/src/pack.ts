import type { EmbeddingModel, EmbedInput } from './types.js';
import { InputTooLong } from './failures.js';
import { countTokens } from './tokens.js';

/** A run of consecutive inputs sent as one request: `inputs.slice(start, end)`. */
export type Chunk = { readonly start: number; readonly end: number };

/**
 * Splits inputs, in order, into chunks of at most `model.maxBatch` inputs and `model.maxBatchTokens`
 * tokens. An input over `maxInputTokens` (unless truncating) or alone over `maxBatchTokens` is refused
 * before any chunk is sent. With `truncate`, an input costs at most `model.maxInputTokens`: that is
 * all of it the provider gets.
 */
export function pack(model: EmbeddingModel, inputs: readonly EmbedInput[], truncate = false) {
  const chunks: Chunk[] = [];
  let start = 0;
  let tokens = 0;
  for (const [index, input] of inputs.entries()) {
    const counted = countTokens(model, input);
    const full = counted.basis === 'unknown' ? 0 : counted.count;
    // Refused here, not per chunk: a later over-long input must not let earlier chunks be billed first.
    if (!truncate && counted.basis !== 'unknown' && counted.count > model.maxInputTokens) {
      return InputTooLong({ index, tokens: counted, max: model.maxInputTokens });
    }
    const cost = truncate ? Math.min(full, model.maxInputTokens) : full;
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
