import type { EmbeddingModel, NativeEmbeddings, NativeRequest } from '../types.js';
import type { EmbedFailure } from '../failures.js';
import { NO_INSTRUCTION } from '../instructions.js';

/** A unit-ish vector of `dimensions` values whose first entry encodes `seed`, so tests can trace order. */
export function tracer(seed: number, dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_, index) => (index === 0 ? seed + 1 : 0.5));
}

/** A model record whose native call is `embedTexts`; every fact can be overridden. */
export function stubModel(
  embedTexts: (request: NativeRequest) => Promise<NativeEmbeddings | EmbedFailure>,
  facts: Partial<Omit<EmbeddingModel, 'embedTexts'>> = {},
): EmbeddingModel {
  return {
    provider: 'fake',
    id: 'stub',
    assurance: 'immutable',
    local: true,
    dimensions: 4,
    matryoshka: [4, 2],
    maxInputTokens: 1000,
    maxBatch: 8,
    maxBatchTokens: 1000,
    normalized: true,
    instruction: NO_INSTRUCTION,
    inputs: ['text'],
    quantizations: [],
    ...facts,
    embedTexts,
  };
}

/** A native call answering one tracer vector per text, numbered by the text's own `tN` suffix when present. */
export const echoTexts = ({ texts, dimensions }: NativeRequest): Promise<NativeEmbeddings> =>
  Promise.resolve({
    vectors: texts.map((text, index) => tracer(Number(/t(\d+)$/.exec(text)?.[1] ?? index), dimensions ?? 4)),
    tokens: { basis: 'reported', count: texts.length },
  });
