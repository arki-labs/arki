import type { Embedder, EmbeddingModel, EmbeddingSpace, Quantization } from './types.js';
import { Cancelled } from './failures.js';

const QUANTIZATION_TAG = { float32: 'f32', int8: 'i8', binary: 'bin' } as const satisfies Record<Quantization, string>;

/**
 * The space as one readable string, e.g. `'ollama/qwen3-embedding:0.6b@<digest>/1024/l2/f32/i1'`.
 * Int8 made by this package names its calibration: `…/i8@<calibration>/…`. Apps store it next to
 * every vector, so the format never changes.
 *
 * @example
 * await db.insert(indexes).values({ spaceId: spaceId(batch.space) });
 */
export function spaceId(space: EmbeddingSpace): string {
  const revision = space.revision === undefined ? '' : `@${space.revision}`;
  const norm = space.normalized ? 'l2' : 'raw';
  const dtype = QUANTIZATION_TAG[space.quantization] + (space.calibration === undefined ? '' : `@${space.calibration}`);
  return `${space.provider}/${space.model}${revision}/${space.dimensions}/${norm}/${dtype}/i${space.instructionVersion}`;
}

/**
 * True when vectors from `a` and `b` are comparable. `revision` counts only when both sides know it.
 *
 * @example
 * if (!isSameSpace(storedSpace, embedder.space)) throw new Error('re-embed the corpus');
 */
export function isSameSpace(a: EmbeddingSpace, b: EmbeddingSpace): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.dimensions === b.dimensions &&
    a.normalized === b.normalized &&
    a.quantization === b.quantization &&
    a.calibration === b.calibration &&
    a.instructionVersion === b.instructionVersion &&
    (a.revision === undefined || b.revision === undefined || a.revision === b.revision)
  );
}

/**
 * The space a model produces at the given output options; `calibration` is the id of a client-side
 * int8 calibration. Read again after a call: Ollama learns its revision lazily.
 */
export function spaceOf(
  model: EmbeddingModel,
  dimensions: number,
  quantization: Quantization,
  calibration?: string,
): EmbeddingSpace {
  const space = {
    provider: model.provider,
    model: model.id,
    dimensions,
    normalized: model.normalized,
    quantization,
    ...(calibration === undefined ? {} : { calibration }),
    instructionVersion: model.instruction.version,
  };
  return model.revision === undefined ? space : { ...space, revision: model.revision };
}

/**
 * The embedder's space with its revision known, to compare with a stored space id before anything
 * is embedded. Ollama reads its model digest (one metadata request, no embedding); other models
 * answer at once. A digest it cannot read is `ModelUnavailable` (`unreachable` or `not-pulled`).
 *
 * @example
 * const space = await resolveSpace(embedder);
 * if (!isFailure(space) && !isSameSpace(storedSpace, space)) return SpaceMismatch({ expected: storedSpace, actual: space });
 */
export async function resolveSpace(embedder: Embedder, options: { readonly signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) return Cancelled();
  const missing = await embedder.model.loadRevision?.(options.signal);
  if (options.signal?.aborted) return Cancelled();
  if (missing !== undefined) return missing;
  return embedder.space;
}
