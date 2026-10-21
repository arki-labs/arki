import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type {
  EmbedInput,
  EmbedOptions,
  Embedder,
  EmbeddingBatch,
  EmbeddingModel,
  EmbeddingSpace,
  EmbeddingsLogger,
  NativeEmbeddings,
  Quantization,
} from './types.js';
import { Cancelled, InvalidOutput, UnsupportedInput } from './failures.js';
import { spaceOf } from './space.js';

/** Output options an embedder is created with. */
export type EmbedderOptions = {
  readonly dimensions?: number;
  readonly quantization?: 'int8' | 'binary';
  readonly log?: EmbeddingsLogger;
};

/** The size refusal shared by the factory and per-call options: only the native size or a listed truncation. */
function checkDimensions(model: EmbeddingModel, dimensions: number) {
  if (dimensions === model.dimensions || model.matryoshka.includes(dimensions)) return;
  return UnsupportedInput({ index: -1, part: 'dimensions' });
}

function checkQuantization(model: EmbeddingModel, quantization: 'int8' | 'binary' | undefined) {
  if (quantization === undefined || model.quantizations.includes(quantization)) return;
  return UnsupportedInput({ index: -1, part: 'quantization' });
}

/**
 * A model with fixed output options. Refuses sizes outside `model.matryoshka` and dtypes the
 * provider cannot produce with `UnsupportedInput`, never a throw.
 *
 * @example
 * const embedder = createEmbedder(model, { dimensions: 512 }); // an Embedder, or UnsupportedInput
 */
export function createEmbedder(model: EmbeddingModel, options: EmbedderOptions = {}) {
  const dimensions = options.dimensions ?? model.dimensions;
  const refused = checkDimensions(model, dimensions) ?? checkQuantization(model, options.quantization);
  if (refused) return refused;
  return buildEmbedder(model, dimensions, options.quantization ?? 'float32', options.log ?? getLogger('arki:embeddings'));
}

/** `createEmbedder` after its checks. `./testing` uses it directly: the fake's options are always valid. */
export function buildEmbedder(
  model: EmbeddingModel,
  dimensions: number,
  quantization: Quantization,
  log: EmbeddingsLogger,
): Embedder {
  log.debug('embedder created for {provider}:{model} at {dimensions} dims', {
    provider: model.provider,
    model: model.id,
    dimensions,
  });

  const embed = async (inputs: readonly EmbedInput[], options: EmbedOptions) => {
    if (options.signal?.aborted) return Cancelled();
    // Truncation needs a tokenizer to cut at the right place; it arrives in slice 1. Refusing is
    // louder than embedding the whole text anyway.
    if (options.onTooLong === 'truncate') return UnsupportedInput({ index: -1, part: 'truncate' });
    const callDimensions = options.dimensions ?? dimensions;
    const callQuantization = options.quantization ?? (quantization === 'float32' ? undefined : quantization);
    const refused = checkDimensions(model, callDimensions) ?? checkQuantization(model, callQuantization);
    if (refused) return refused;
    if (inputs.length > model.maxBatch) return UnsupportedInput({ index: model.maxBatch, part: 'batch' });

    const prefix = options.purpose === undefined ? '' : (model.instruction[options.purpose] ?? '');
    const texts: string[] = [];
    for (const [index, input] of inputs.entries()) {
      if (typeof input === 'string') {
        texts.push(prefix + input);
        continue;
      }
      if (input.image !== undefined && !model.inputs.includes('image')) return UnsupportedInput({ index, part: 'image' });
      if (input.text === undefined) return UnsupportedInput({ index, part: 'text' });
      texts.push(prefix + input.text);
    }

    const native = await model.embedTexts({
      texts,
      ...(callDimensions === model.dimensions ? {} : { dimensions: callDimensions }),
      ...(callQuantization === undefined ? {} : { quantization: callQuantization }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (isFailure(native)) {
      log.debug('{provider}:{model} refused {count} inputs: {code}', {
        provider: model.provider,
        model: model.id,
        count: inputs.length,
        code: native.code,
      });
      return native;
    }

    // Read after the call: a lazily learned revision (Ollama's digest) is part of the space.
    const space = spaceOf(model, callDimensions, callQuantization ?? 'float32');
    const vectors = validate(native, inputs.length, space);
    if (isFailure(vectors)) return vectors;
    const usage = {
      tokens: native.tokens,
      requests: 1,
      cacheHits: 0,
      ...(native.loadMs === undefined ? {} : { loadMs: native.loadMs }),
    };
    return { vectors, space, usage } satisfies EmbeddingBatch;
  };

  return {
    model,
    get space() {
      return spaceOf(model, dimensions, quantization);
    },
    embed,
  };
}

/** Values per vector: one per dimension, or one bit per dimension for packed binary. */
function expectedLength(space: EmbeddingSpace): number {
  return space.quantization === 'binary' ? Math.ceil(space.dimensions / 8) : space.dimensions;
}

/**
 * Checks every vector the provider answered and converts it to the space's typed array. Any miss
 * discards the whole batch: count, length, a non-number or non-finite value, or a zero vector
 * (which would match everything at cosine 0 and poison an index).
 */
function validate(native: NativeEmbeddings, count: number, space: EmbeddingSpace) {
  if (native.vectors.length !== count)
    return InvalidOutput({ reason: `count: expected ${count} vectors, got ${native.vectors.length}` });
  const length = expectedLength(space);
  const vectors: (Float32Array | Int8Array | Uint8Array)[] = [];
  for (const [index, raw] of native.vectors.entries()) {
    if (raw.length !== length)
      return InvalidOutput({ reason: `dimensions: expected ${length}, got ${raw.length} at index ${index}` });
    const vector =
      space.quantization === 'int8'
        ? new Int8Array(length)
        : space.quantization === 'binary'
          ? new Uint8Array(length)
          : new Float32Array(length);
    let squares = 0;
    for (let position = 0; position < length; position++) {
      const value = raw[position];
      if (typeof value !== 'number') return InvalidOutput({ reason: `non-number at index ${index}` });
      vector[position] = value;
      const stored = vector[position] ?? Number.NaN;
      if (!Number.isFinite(stored)) return InvalidOutput({ reason: `non-finite value at index ${index}` });
      squares += stored * stored;
    }
    if (squares === 0) return InvalidOutput({ reason: `zero-norm at index ${index}` });
    vectors.push(vector);
  }
  return vectors;
}
