import { isFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import type {
  EmbedInput,
  Embedding,
  EmbedOptions,
  Embedder,
  EmbeddingBatch,
  EmbeddingModel,
  EmbeddingSpace,
  EmbeddingsLogger,
  Int8Calibration,
  NativeEmbeddings,
  Quantization,
} from './types.js';
import { Cancelled, InputTooLong, InvalidOutput, UnsupportedInput } from './failures.js';
import { calibrationId, quantize } from './quantize.js';
import { spaceOf } from './space.js';
import { countTokens } from './tokens.js';

/** Output options an embedder is created with. */
export type EmbedderOptions = {
  readonly dimensions?: number;
  /**
   * Asked of the provider when it makes this dtype natively, else made here from validated floats:
   * `'binary'` always (size a multiple of 8), `'int8'` only with a `calibration`.
   */
  readonly quantization?: 'int8' | 'binary';
  /** The corpus's shared int8 range (`calibrateInt8`). With it, int8 is always made here and the space names it. */
  readonly calibration?: Int8Calibration;
  readonly log?: EmbeddingsLogger;
};

/** The size refusal shared by the factory and per-call options: only the native size or a listed truncation. */
function checkDimensions(model: EmbeddingModel, dimensions: number) {
  if (dimensions === model.dimensions || model.matryoshka.includes(dimensions)) return;
  return UnsupportedInput({ index: -1, part: 'dimensions' });
}

/**
 * How one call gets its dtype: `native` is asked of the provider, `made` is made here from floats.
 * A dtype neither can produce at this size is `UnsupportedInput`.
 */
function outputPlan(
  model: EmbeddingModel,
  dimensions: number,
  quantization: 'int8' | 'binary' | undefined,
  calibration: Int8Calibration | undefined,
) {
  if (quantization === undefined) return {};
  // An explicit calibration means int8 made here, so the space can name the range it used.
  if (quantization === 'int8' && calibration !== undefined) {
    if (calibration.min.length !== dimensions) return UnsupportedInput({ index: -1, part: 'dimensions' });
    return { made: 'int8' as const };
  }
  if (model.quantizations.includes(quantization)) return { native: quantization };
  if (quantization === 'int8') return UnsupportedInput({ index: -1, part: 'quantization' });
  if (dimensions % 8 !== 0) return UnsupportedInput({ index: -1, part: 'dimensions' });
  return { made: 'binary' as const };
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
  const refused = checkDimensions(model, dimensions);
  if (refused) return refused;
  const plan = outputPlan(model, dimensions, options.quantization, options.calibration);
  if (isFailure(plan)) return plan;
  return buildEmbedder(
    model,
    dimensions,
    options.quantization ?? 'float32',
    options.log ?? getLogger('arki:embeddings'),
    options.calibration,
  );
}

/** `createEmbedder` after its checks. `./testing` uses it directly: the fake's options are always valid. */
export function buildEmbedder(
  model: EmbeddingModel,
  dimensions: number,
  quantization: Quantization,
  log: EmbeddingsLogger,
  calibration?: Int8Calibration,
): Embedder {
  // Hashed once. With a calibration every int8 is made here (`outputPlan`), so int8 names it.
  const calibrationTag = calibration === undefined ? undefined : calibrationId(calibration);
  const spaceAt = (size: number, dtype: Quantization) =>
    spaceOf(model, size, dtype, dtype === 'int8' ? calibrationTag : undefined);

  log.debug('embedder created for {provider}:{model} at {dimensions} dims', {
    provider: model.provider,
    model: model.id,
    dimensions,
  });

  const embed = async (inputs: readonly EmbedInput[], options: EmbedOptions) => {
    if (options.signal?.aborted) return Cancelled();
    const truncate = options.onTooLong === 'truncate';
    const callDimensions = options.dimensions ?? dimensions;
    const callQuantization = options.quantization ?? (quantization === 'float32' ? undefined : quantization);
    const refused = checkDimensions(model, callDimensions);
    if (refused) return refused;
    const plan = outputPlan(model, callDimensions, callQuantization, calibration);
    if (isFailure(plan)) return plan;
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
    if (!truncate) {
      // The prefix is sent too, so it counts against the model's limit.
      for (const [index, text] of texts.entries()) {
        const tokens = countTokens(model, text);
        if (tokens.basis !== 'unknown' && tokens.count > model.maxInputTokens) {
          return InputTooLong({ index, tokens, max: model.maxInputTokens });
        }
      }
    }

    const native = await model.embedTexts({
      texts,
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(callDimensions === model.dimensions ? {} : { dimensions: callDimensions }),
      ...(plan.native === undefined ? {} : { quantization: plan.native }),
      ...(truncate ? { truncate } : {}),
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
    const space = spaceAt(callDimensions, callQuantization ?? 'float32');
    // A dtype made here is made from floats, and the floats are what the provider is held to.
    const answered = validate(native, inputs.length, plan.made === undefined ? space : { ...space, quantization: 'float32' });
    if (isFailure(answered)) return answered;
    const vectors = plan.made === undefined ? answered : made(answered, plan.made, calibration);
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
      return spaceAt(dimensions, quantization);
    },
    spaceFor: options => spaceAt(options.dimensions ?? dimensions, options.quantization ?? quantization),
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

/** Validated floats converted to the dtype made here. `outputPlan` already checked the sizes. */
function made(vectors: readonly Embedding['vector'][], to: 'int8' | 'binary', calibration: Int8Calibration | undefined) {
  const out: Embedding['vector'][] = [];
  for (const vector of vectors) {
    if (!(vector instanceof Float32Array)) return InvalidOutput({ reason: 'expected float vectors to quantize' });
    const converted =
      to === 'int8'
        ? calibration === undefined
          ? UnsupportedInput({ index: -1, part: 'quantization' })
          : quantize(vector, 'int8', calibration)
        : quantize(vector, 'binary');
    if (isFailure(converted)) return converted;
    out.push(converted);
  }
  return out;
}
